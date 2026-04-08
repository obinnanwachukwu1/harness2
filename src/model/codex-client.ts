import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { jsonSchema, stepCountIs, streamText, tool, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { OPENAI_CODEX_ORIGINATOR, OpenAICodexAuth } from '../auth/openai-codex.js';
import { ExperimentBudgetExceededError } from '../experiments/experiment-manager.js';
import { clampText, DEFAULT_EXPERIMENT_BUDGET_TOKENS, estimateTokens, nowIso } from '../lib/utils.js';
import { EXPERIMENT_SUBAGENT_PROMPT, MAIN_AGENT_PROMPT } from './codex-prompt.js';
import { Notebook } from '../storage/notebook.js';
import type {
  AgentTools,
  ExperimentObservationTag,
  ModelHistoryItem,
  ModelSessionRecord,
  StudyDebtKind,
  StudyDebtResolution,
  TranscriptRole
} from '../types.js';

const DEFAULT_MODEL = process.env.H2_CODEX_MODEL ?? 'gpt-5.4';
const DEFAULT_REASONING_EFFORT = normalizeReasoningEffort(process.env.H2_REASONING_EFFORT) ?? 'medium';
const DEFAULT_ENDPOINT =
  process.env.H2_CODEX_BASE_URL ?? 'https://chatgpt.com/backend-api/codex/responses';
const MAX_MODEL_STEPS = normalizeMaxModelSteps(process.env.H2_MAX_MODEL_STEPS);
const MAX_TRANSIENT_MODEL_RETRIES = 2;
const DEBUG_RESPONSES_ENABLED = process.env.H2_DEBUG_RESPONSES === '1';
const DEBUG_RESPONSES_FILE =
  process.env.H2_DEBUG_RESPONSES_FILE ??
  path.join(process.cwd(), '.h2', 'debug', 'responses.jsonl');
const DEFAULT_WEB_SEARCH_MODE = 'cached';

interface CodexModelClientOptions {
  fetchImpl?: typeof fetch;
  endpoint?: string;
  model?: string;
}

interface ModelStepResponse {
  id?: string;
  assistantText: string;
  reasoningSummary: string;
  toolCalls: ToolCall[];
  providerToolEvents: ProviderToolEvent[];
}

interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface ContextWindowUsage {
  usedTokens: number;
  totalTokens: number;
  standardRateTokens: number | null;
}

interface ToolExecutionResult {
  output: string;
  failed: boolean;
}

interface ProviderToolEvent {
  name: 'web_search';
  toolCallId: string;
  transcript: string;
  historyNotice: string;
}

export class CodexModelClient {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly defaultModel: string;
  private readonly aiProviderBaseUrl: string;

  constructor(
    private readonly notebook: Notebook,
    private readonly auth: OpenAICodexAuth,
    options: CodexModelClientOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.defaultModel = options.model ?? DEFAULT_MODEL;
    this.aiProviderBaseUrl = 'https://api.openai.com/v1';
  }

  async runTurn(
    sessionId: string,
    inputText: string,
    tools: AgentTools,
    emit: (role: TranscriptRole, text: string) => Promise<void>,
    onAssistantStream?: (text: string) => Promise<void>,
    onReasoningSummaryStream?: (text: string) => Promise<void>,
    thinkingEnabled = false,
    toolDefinitions: readonly ToolDefinition[] = MAIN_TOOL_DEFINITIONS,
    instructions = MAIN_AGENT_PROMPT,
    onToolCallStart?: (toolCall: {
      toolCallId: string;
      toolName: string;
      label: string;
      detail?: string | null;
      body?: string[];
      providerExecuted?: boolean;
    }) => Promise<void>,
    onToolCallFinish?: (toolCallId: string, transcriptText?: string) => Promise<void>
  ): Promise<void> {
    const accessToken = await this.auth.access();
    const authRecord = this.auth.getStored();

    if (!accessToken || !authRecord) {
      await emit(
        'assistant',
        'OpenAI Codex OAuth is not configured. Run `/auth login` or `h2 auth login` first.'
      );
      return;
    }

    const settings = this.getSessionSettings(sessionId);
    let previousResponseId = settings.previousResponseId;
    let requestItems = this.notebook.buildModelRequestHistory(sessionId);

    if (requestItems.length === 0) {
      const seedUserMessage: ModelHistoryItem = {
        type: 'message',
        role: 'user',
        content: inputText
      };
      this.persistHistoryItem(sessionId, seedUserMessage);
      requestItems = this.notebook.buildModelRequestHistory(sessionId);
    }

    for (let step = 0; ; step += 1) {
      if (MAX_MODEL_STEPS !== null && step >= MAX_MODEL_STEPS) {
        await emit(
          'assistant',
          `Stopped after ${MAX_MODEL_STEPS} model/tool steps. Increase H2_MAX_MODEL_STEPS if this turn needs more tool work.`
        );
        return;
      }

      const earlyStudyOpportunityHint = shouldInjectEarlyStudyOpportunityHint(
        inputText,
        requestItems,
        toolDefinitions
      )
        ? buildEarlyStudyOpportunityHint()
        : null;
      const hints = [
        earlyStudyOpportunityHint,
        !earlyStudyOpportunityHint &&
        shouldInjectExperimentHint(inputText, requestItems, toolDefinitions)
          ? buildExperimentHint()
          : null,
        shouldInjectPreEditGuardHint(requestItems) ? buildPreEditGuardHint() : null,
        shouldInjectPostSpawnWaitHint(requestItems) ? buildPostSpawnWaitHint() : null,
        shouldInjectObservationHint(requestItems, toolDefinitions)
          ? buildObservationHint()
          : null
      ].filter((value): value is string => Boolean(value));
      const response = await this.createResponse({
        accessToken,
        accountId: authRecord.accountId,
        sessionId,
        settings,
        input: [
          ...hints.map((hint) => ({
            role: 'developer' as const,
            content: hint
          })),
          ...requestItems.map(toResponseInputItem)
        ],
        onAssistantStream,
        onReasoningSummaryStream,
        thinkingEnabled,
        toolDefinitions,
        instructions,
        onToolCallStart,
        onProviderToolEvent: async (event) => {
          this.persistHistoryItem(sessionId, {
            type: 'message',
            role: 'developer',
            content: event.historyNotice
          });
          await emit('tool', event.transcript);
          await onToolCallFinish?.(event.toolCallId, event.transcript);
        }
      });

      previousResponseId = response.id ?? previousResponseId;
      this.persistSession({
        sessionId,
        provider: 'openai-codex',
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        previousResponseId,
        updatedAt: nowIso()
      });

      const toolCalls = response.toolCalls;
      const assistantText = response.assistantText;
      const reasoningSummary = thinkingEnabled ? response.reasoningSummary : '';
      const providerToolEvents = response.providerToolEvents;

      if (reasoningSummary) {
        await onReasoningSummaryStream?.(reasoningSummary);
        await emit('system', `@@thinking\t${reasoningSummary}`);
      }

      for (const event of providerToolEvents) {
        this.persistHistoryItem(sessionId, {
          type: 'message',
          role: 'developer',
          content: event.historyNotice
        });
        await emit('tool', event.transcript);
        await onToolCallFinish?.(event.toolCallId, event.transcript);
      }

      if (assistantText) {
        this.persistHistoryItem(sessionId, {
          type: 'message',
          role: 'assistant',
          content: assistantText
        });
        await emit('assistant', assistantText);
      }

      if (toolCalls.length === 0) {
        if (!assistantText) {
          await debugResponseShape(sessionId, 'no_visible_text_fallback', {
            responseId: response.id ?? null,
            response
          });
          const fallback = 'The model returned no visible text.';
          this.persistHistoryItem(sessionId, {
            type: 'message',
            role: 'assistant',
            content: fallback
          });
          await emit('assistant', fallback);
        }
        return;
      }

      for (let index = 0; index < toolCalls.length; ) {
        const batchCalls = [toolCalls[index]!];
        let nextIndex = index + 1;

        if (isParallelReadOnlyToolCall(batchCalls[0]!)) {
          while (nextIndex < toolCalls.length && isParallelReadOnlyToolCall(toolCalls[nextIndex]!)) {
            batchCalls.push(toolCalls[nextIndex]!);
            nextIndex += 1;
          }
        }

        for (const call of batchCalls) {
          await onToolCallStart?.({
            toolCallId: call.callId,
            toolName: call.name,
            label: formatToolHeader(call.name, call.rawArguments),
            detail: call.name === 'web_search' ? 'searching…' : 'running…',
            body: formatLiveToolBody(call.name, call.rawArguments),
            providerExecuted: false
          });
        }

        const results = await executeToolCallBatch(batchCalls, tools);

        for (let batchIndex = 0; batchIndex < batchCalls.length; batchIndex += 1) {
          const call = batchCalls[batchIndex]!;
          const result = results[batchIndex]!;
          const functionCallItem: ModelHistoryItem = {
            type: 'function_call',
            call_id: call.callId,
            name: call.name,
            arguments: call.rawArguments
          };
          const functionCallOutputItem: ModelHistoryItem = {
            type: 'function_call_output',
            call_id: call.callId,
            output: result.output
          };

          this.persistHistoryItem(sessionId, functionCallItem);
          this.persistHistoryItem(sessionId, functionCallOutputItem);
          const transcriptText = formatToolOutput(
            call.name,
            call.rawArguments,
            result.failed ? `${result.output}\nTool execution failed.` : result.output
          );
          await emit('tool', transcriptText);
          await onToolCallFinish?.(call.callId, transcriptText);
        }

        index = nextIndex;
      }

      requestItems = this.notebook.buildModelRequestHistory(sessionId);
    }
  }

  getSettings(sessionId: string): ModelSessionRecord {
    return this.getSessionSettings(sessionId);
  }

  setModel(sessionId: string, model: string): ModelSessionRecord {
    const normalized = model.trim();
    if (!normalized) {
      throw new Error('Model name cannot be empty.');
    }

    const current = this.getSessionSettings(sessionId);
    const next: ModelSessionRecord = {
      ...current,
      model: normalized,
      updatedAt: nowIso()
    };
    this.persistSession(next);
    return next;
  }

  setReasoningEffort(
    sessionId: string,
    effort: 'low' | 'medium' | 'high' | 'off'
  ): ModelSessionRecord {
    const current = this.getSessionSettings(sessionId);
    const next: ModelSessionRecord = {
      ...current,
      reasoningEffort: effort === 'off' ? null : effort,
      updatedAt: nowIso()
    };
    this.persistSession(next);
    return next;
  }

  getContextWindowUsage(sessionId: string): ContextWindowUsage {
    const settings = this.getSessionSettings(sessionId);
    const historyItems = this.notebook.buildModelRequestHistory(sessionId);
    const usedTokens =
      estimateTokens(MAIN_AGENT_PROMPT) +
      estimateTokens(JSON.stringify(MAIN_TOOL_DEFINITIONS)) +
      historyItems.reduce((total, item) => total + estimateHistoryItemTokens(item), 0);

    return {
      usedTokens,
      totalTokens: getModelContextWindow(settings.model),
      standardRateTokens: getModelStandardRateThreshold(settings.model)
    };
  }

  private async createResponse(input: {
    accessToken: string;
    accountId: string;
    sessionId: string;
    settings: ModelSessionRecord;
    input: Array<{ role: 'user' | 'assistant' | 'system' | 'developer'; content: string } | {
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
    } | {
      type: 'function_call_output';
      call_id: string;
      output: string;
    }>;
    onAssistantStream?: (text: string) => Promise<void>;
    onReasoningSummaryStream?: (text: string) => Promise<void>;
    onToolCallStart?: (toolCall: {
      toolCallId: string;
      toolName: string;
      label: string;
      detail?: string | null;
      body?: string[];
      providerExecuted?: boolean;
    }) => Promise<void>;
    onProviderToolEvent?: (event: ProviderToolEvent) => Promise<void>;
    thinkingEnabled: boolean;
    toolDefinitions: readonly ToolDefinition[];
    instructions: string;
  }): Promise<ModelStepResponse> {
    const provider = this.createCodexProvider(input.accessToken, input.accountId, input.sessionId);
    const model = provider.responses(input.settings.model);
    const messages = buildAiSdkMessages(input.input);
    const tools = buildAiSdkTools(input.toolDefinitions, provider, getWebSearchMode());
    let liveAssistantText = '';
    let liveReasoningSummary = '';

    await debugResponseShape(input.sessionId, 'request', {
      endpoint: this.endpoint,
      model: input.settings.model,
      reasoning:
        input.settings.reasoningEffort || input.thinkingEnabled
          ? {
              effort: input.settings.reasoningEffort ?? null,
              summary: input.thinkingEnabled ? 'auto' : null
            }
          : null,
      input: messages,
      prompt_cache_key: input.sessionId
    });

    const result = streamText({
      model,
      messages,
      tools,
      toolChoice: 'auto',
      stopWhen: stepCountIs(1),
      maxRetries: MAX_TRANSIENT_MODEL_RETRIES,
      providerOptions: {
        openai: {
          instructions: input.instructions,
          promptCacheKey: input.sessionId,
          store: false,
          systemMessageMode: 'developer',
          ...(input.settings.reasoningEffort
            ? { reasoningEffort: input.settings.reasoningEffort }
            : {}),
          ...(input.thinkingEnabled ? { reasoningSummary: 'auto' } : {})
        }
      },
      onChunk: async ({ chunk }) => {
        if (chunk.type === 'text-delta') {
          liveAssistantText += chunk.text;
          await input.onAssistantStream?.(liveAssistantText);
        }

        if (chunk.type === 'reasoning-delta') {
          liveReasoningSummary += chunk.text;
          await input.onReasoningSummaryStream?.(liveReasoningSummary);
        }
      },
      onError: async ({ error }) => {
        throw error;
      }
    });

    const announcedProviderToolCalls = new Set<string>();
    const emittedProviderToolResults = new Set<string>();
    for await (const part of result.fullStream) {
      if (
        part.type === 'tool-call' &&
        part.providerExecuted === true &&
        !announcedProviderToolCalls.has(part.toolCallId)
      ) {
        announcedProviderToolCalls.add(part.toolCallId);
        await input.onToolCallStart?.({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          label: formatToolHeader(part.toolName, JSON.stringify(part.input)),
          detail: 'searching…',
          body: formatLiveToolBody(part.toolName, JSON.stringify(part.input)),
          providerExecuted: true
        });
      }

      if (
        part.type === 'tool-result' &&
        part.providerExecuted === true &&
        !part.preliminary &&
        !emittedProviderToolResults.has(part.toolCallId)
      ) {
        const event = buildProviderToolEventFromOutput(part.toolCallId, part.output);
        if (event) {
          emittedProviderToolResults.add(part.toolCallId);
          await input.onProviderToolEvent?.(event);
        }
      }
    }

    const response = await result.response;
    const assistantText = await result.text;
    const reasoningSummary = await result.reasoningText;
    const toolCalls = await result.toolCalls;
    const toolResults = await result.toolResults;
    const sources = await result.sources;
    const providerToolEvents = buildProviderToolEvents(toolCalls, toolResults, sources).filter(
      (event) => !emittedProviderToolResults.has(event.toolCallId)
    );
    const localToolCalls = toolCalls.filter((call) => !call.providerExecuted);

    await debugResponseShape(input.sessionId, 'sdk_response', {
      id: response.id ?? null,
      finishReason: await result.finishReason,
      text: assistantText,
      reasoningText: reasoningSummary ?? null,
      toolCalls: toolCalls.map((call) => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        providerExecuted: call.providerExecuted ?? false
      })),
      toolResults,
      sources,
      usage: await result.usage
    });

    return {
      id: response.id ?? undefined,
      assistantText: (assistantText.trim() || liveAssistantText.trim()),
      reasoningSummary: (reasoningSummary?.trim() || liveReasoningSummary.trim()),
      toolCalls: localToolCalls.map((call) => ({
        name: call.toolName,
        callId: call.toolCallId,
        rawArguments: JSON.stringify(call.input)
      })),
      providerToolEvents
    };
  }

  private createCodexProvider(accessToken: string, accountId: string, sessionId: string) {
    return createOpenAI({
      apiKey: accessToken,
      baseURL: this.aiProviderBaseUrl,
      fetch: async (requestInput, init) => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${accessToken}`);
        headers.set('originator', OPENAI_CODEX_ORIGINATOR);
        headers.set('session_id', sessionId);

        if (accountId) {
          headers.set('chatgpt-account-id', accountId);
        }

        const parsed =
          requestInput instanceof URL
            ? requestInput
            : new URL(typeof requestInput === 'string' ? requestInput : requestInput.url);
        const url =
          parsed.pathname.includes('/v1/responses') || parsed.pathname.includes('/chat/completions')
            ? new URL(this.endpoint)
            : parsed;

        return this.fetchWithRetries(url, {
          ...init,
          headers
        });
      }
    });
  }

  private persistSession(record: ModelSessionRecord): void {
    this.notebook.upsertModelSession(record);
  }

  private async fetchWithRetries(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
    let attempt = 0;
    let lastResponse: Response | null = null;

    while (attempt <= MAX_TRANSIENT_MODEL_RETRIES) {
      const response = await this.fetchImpl(input, init);
      if (response.status !== 500) {
        return response;
      }

      lastResponse = response;
      if (attempt === MAX_TRANSIENT_MODEL_RETRIES) {
        return response;
      }

      attempt += 1;
      await delay(250 * attempt);
    }

    return lastResponse ?? this.fetchImpl(input, init);
  }

  private persistHistoryItem(sessionId: string, item: ModelHistoryItem): void {
    this.notebook.appendModelHistoryItem(sessionId, item);
  }

  private getSessionSettings(sessionId: string): ModelSessionRecord {
    const existing = this.notebook.getModelSession(sessionId);
    if (existing) {
      return {
        ...existing,
        reasoningEffort: existing.reasoningEffort ?? DEFAULT_REASONING_EFFORT
      };
    }

    return {
      sessionId,
      provider: 'openai-codex',
      model: this.defaultModel,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      previousResponseId: null,
      updatedAt: nowIso()
    };
  }
}

interface ToolCall {
  name: string;
  callId: string;
  rawArguments: string;
}

async function executeToolCall(call: ToolCall, tools: AgentTools): Promise<string> {
  const args = parseArguments(call.rawArguments);

  switch (call.name) {
    case 'bash':
      return tools.bash(readStringArg(args, 'command'));
    case 'read':
      return tools.read(
        readStringArg(args, 'path'),
        readOptionalNumberArg(args, 'startLine'),
        readOptionalNumberArg(args, 'endLine')
      );
    case 'ls':
      if (!tools.ls) {
        throw new Error('ls is not available in this session.');
      }
      return tools.ls(
        readOptionalStringArg(args, 'path'),
        readOptionalBooleanArg(args, 'recursive')
      );
    case 'write':
      if (!tools.write) {
        throw new Error('write is not available in this session.');
      }
      return tools.write(readStringArg(args, 'path'), readStringArg(args, 'content'));
    case 'edit':
      return tools.edit(
        readStringArg(args, 'path'),
        readStringArg(args, 'findText'),
        readStringArg(args, 'replaceText')
      );
    case 'glob':
      return JSON.stringify(await tools.glob(readStringArg(args, 'pattern')), null, 2);
    case 'rg':
      if (!tools.rg) {
        throw new Error('rg is not available in this session.');
      }
      return tools.rg(readStringArg(args, 'pattern'), readOptionalStringOrArrayArg(args, 'target'));
    case 'grep':
      if (tools.grep) {
        return tools.grep(
          readStringArg(args, 'pattern'),
          readOptionalStringOrArrayArg(args, 'target')
        );
      }
      if (!tools.rg) {
        throw new Error('rg is not available in this session.');
      }
      return tools.rg(readStringArg(args, 'pattern'), readOptionalStringOrArrayArg(args, 'target'));
    case 'spawn_experiment': {
      const experiment = await tools.spawnExperiment({
        studyDebtId:
          readOptionalStringArg(args, 'questionId') ?? readOptionalStringArg(args, 'studyDebtId'),
        hypothesis: readStringArg(args, 'hypothesis'),
        localEvidenceSummary: readStringArg(args, 'localEvidenceSummary'),
        residualUncertainty: readStringArg(args, 'residualUncertainty'),
        context: readOptionalStringArg(args, 'context'),
        budgetTokens:
          readOptionalNumberArg(args, 'budgetTokens') ?? DEFAULT_EXPERIMENT_BUDGET_TOKENS,
        preserve: readOptionalBooleanArg(args, 'preserve') ?? false
      });
      return JSON.stringify(serializeExperimentForModel(experiment), null, 2);
    }
    case 'extend_experiment_budget':
      if (!tools.extendExperimentBudget) {
        throw new Error('extend_experiment_budget is not available in this session.');
      }
      return JSON.stringify(
        await tools.extendExperimentBudget(
          readStringArg(args, 'experimentId'),
          readOptionalNumberArg(args, 'additionalTokens') ?? 0
        ),
        null,
        2
      );
    case 'read_experiment':
      return JSON.stringify(
        serializeExperimentForModel(await tools.readExperiment(readStringArg(args, 'experimentId'))),
        null,
        2
      );
    case 'wait_experiment':
      if (!tools.waitExperiment) {
        throw new Error('wait_experiment is not available in this session.');
      }
      return JSON.stringify(
        await tools.waitExperiment(
          readStringArg(args, 'experimentId'),
          normalizeExperimentWaitTimeout(readOptionalNumberArg(args, 'timeoutMs'))
        ),
        null,
        2
      );
    case 'search_experiments':
      if (!tools.searchExperiments) {
        throw new Error('search_experiments is not available in this session.');
      }
      return JSON.stringify(await tools.searchExperiments(readOptionalStringArg(args, 'query')), null, 2);
    case 'open_question':
    case 'open_study_debt':
      if (!tools.openStudyDebt) {
        throw new Error('open_question is not available in this session.');
      }
      return JSON.stringify(
        await tools.openStudyDebt({
          summary: readStringArg(args, 'summary'),
          whyItMatters: readStringArg(args, 'whyItMatters'),
          kind: readOptionalStringArg(args, 'kind') as StudyDebtKind | undefined,
          affectedPaths: readOptionalStringArrayArg(args, 'affectedPaths'),
          recommendedStudy: readOptionalStringArg(args, 'recommendedStudy')
        }),
        null,
        2
      );
    case 'resolve_question':
    case 'resolve_study_debt':
      if (!tools.resolveStudyDebt) {
        throw new Error('resolve_question is not available in this session.');
      }
      return JSON.stringify(
        await tools.resolveStudyDebt({
          questionId:
            readOptionalStringArg(args, 'questionId') ?? readStringArg(args, 'debtId'),
          resolution: readStringArg(args, 'resolution') as StudyDebtResolution,
          note: readStringArg(args, 'note')
        }),
        null,
        2
      );
    case 'compact':
      if (!tools.compact) {
        throw new Error('compact is not available in this session.');
      }
      return JSON.stringify(
        await tools.compact(
        readStringArg(args, 'goal'),
        readStringArg(args, 'completed'),
        readStringArg(args, 'next'),
        readOptionalStringArg(args, 'openRisks')
        ),
        null,
        2
      );
    case 'log_observation':
      if (!tools.logObservation) {
        throw new Error('log_observation is not available in this session.');
      }
      return JSON.stringify(
        await tools.logObservation(
          readStringArg(args, 'experimentId'),
          readStringArg(args, 'message'),
          readOptionalStringArrayArg(args, 'tags') as ExperimentObservationTag[] | undefined
        ),
        null,
        2
      );
    case 'resolve_experiment':
      if (!tools.resolveExperiment) {
        throw new Error('resolve_experiment is not available in this session.');
      }
      return JSON.stringify(
        await tools.resolveExperiment({
          experimentId: readStringArg(args, 'experimentId'),
          verdict: readStringArg(args, 'verdict') as
            | 'validated'
            | 'invalidated'
            | 'inconclusive',
          summary: readStringArg(args, 'summary'),
          discovered: readOptionalStringArrayArg(args, 'discovered') ?? [],
          artifacts: readOptionalStringArrayArg(args, 'artifacts') ?? [],
          constraints: readOptionalStringArrayArg(args, 'constraints') ?? [],
          confidenceNote: readOptionalStringArg(args, 'confidenceNote'),
          promote: readOptionalBooleanArg(args, 'promote') ?? false
        }),
        null,
        2
      );
    default:
      throw new Error(`Unknown model tool: ${call.name}`);
  }
}

async function executeToolCallSafely(
  call: ToolCall,
  tools: AgentTools
): Promise<ToolExecutionResult> {
  try {
    return {
      output: await executeToolCall(call, tools),
      failed: false
    };
  } catch (error) {
    if (error instanceof ExperimentBudgetExceededError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      output: JSON.stringify(
        {
          ok: false,
          error: {
            tool: call.name,
            message
          }
        },
        null,
        2
      ),
      failed: true
    };
  }
}

async function executeToolCallBatch(
  calls: readonly ToolCall[],
  tools: AgentTools
): Promise<ToolExecutionResult[]> {
  if (calls.length <= 1) {
    return calls.length === 1 ? [await executeToolCallSafely(calls[0]!, tools)] : [];
  }

  return Promise.all(calls.map((call) => executeToolCallSafely(call, tools)));
}

function serializeExperimentForModel<T extends object>(value: T): Record<string, unknown> {
  const output: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if ('studyDebtId' in output) {
    output.questionId = output.studyDebtId;
    delete output.studyDebtId;
  }
  return output;
}

function isParallelReadOnlyToolCall(call: ToolCall): boolean {
  return ['read', 'ls', 'glob', 'rg', 'grep'].includes(call.name);
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Tool arguments must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid tool arguments: ${message}`);
  }
}

function readStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing string argument: ${key}`);
  }
  return value;
}

function readOptionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOptionalStringOrArrayArg(
  args: Record<string, unknown>,
  key: string
): string | string[] | undefined {
  const stringValue = readOptionalStringArg(args, key);
  if (stringValue !== undefined) {
    return stringValue;
  }
  return readOptionalStringArrayArg(args, key);
}

function readOptionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readOptionalBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readOptionalStringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  const filtered = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return filtered.length > 0 ? filtered : [];
}

function toResponseInputItem(item: ModelHistoryItem):
  | { role: 'user' | 'assistant' | 'system' | 'developer'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string } {
  if (item.type === 'message') {
    return {
      role: item.role,
      content: item.content
    };
  }

  if (item.type === 'function_call') {
    return item;
  }

  return item;
}

function buildAiSdkMessages(
  items: Array<
    | { role: 'user' | 'assistant' | 'system' | 'developer'; content: string }
    | { type: 'function_call'; call_id: string; name: string; arguments: string }
    | { type: 'function_call_output'; call_id: string; output: string }
  >
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const toolCallNames = new Map<string, string>();

  for (const item of items) {
    if ('role' in item) {
      if (item.role === 'user') {
        messages.push({ role: 'user', content: item.content });
        continue;
      }

      if (item.role === 'assistant') {
        messages.push({ role: 'assistant', content: item.content });
        continue;
      }

      messages.push({ role: 'system', content: item.content });
      continue;
    }

    if (item.type === 'function_call') {
      toolCallNames.set(item.call_id, item.name);
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: item.call_id,
            toolName: item.name,
            input: parseArguments(item.arguments)
          }
        ]
      });
      continue;
    }

    messages.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: item.call_id,
          toolName: toolCallNames.get(item.call_id) ?? 'unknown_tool',
          output: {
            type: 'text',
            value: item.output
          }
        }
      ]
    });
  }

  return messages;
}

function getWebSearchMode(): 'disabled' | 'cached' | 'live' {
  const raw = process.env.H2_WEB_SEARCH_MODE?.trim().toLowerCase();
  if (raw === 'disabled' || raw === 'cached' || raw === 'live') {
    return raw;
  }
  return DEFAULT_WEB_SEARCH_MODE;
}

function buildProviderToolEvents(
  toolCalls: Array<{ toolCallId: string; toolName: string; providerExecuted?: boolean }>,
  toolResults: Array<{
    toolCallId: string;
    toolName: string;
    providerExecuted?: boolean;
    output: unknown;
  }>,
  sources: Array<{ type?: string; url?: string; name?: string }>
): ProviderToolEvent[] {
  const providerToolResults = toolResults.filter(
    (result) => result.providerExecuted && result.toolName === 'web_search'
  );
  const events: ProviderToolEvent[] = [];

  for (const result of providerToolResults) {
    const fallbackSources = sources
      .map((source) => source.url ?? source.name)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const event = buildProviderToolEventFromOutput(result.toolCallId, result.output, fallbackSources);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

function buildProviderToolEventFromOutput(
  toolCallId: string,
  outputValue: unknown,
  fallbackSources: string[] = []
): ProviderToolEvent | null {
  const output = readWebSearchOutput(outputValue);
  const query =
    output?.action?.type === 'search' ? output.action.query?.trim() || undefined : undefined;
  const outputSources = output?.sources
    ?.map((source) => (source.type === 'url' ? source.url : source.name))
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const sourceList = (outputSources && outputSources.length > 0 ? outputSources : fallbackSources).slice(0, 5);
  const queryText = query ?? 'provider-executed web search';
  const transcriptLines = [`query: ${queryText}`];
  if (sourceList.length > 0) {
    transcriptLines.push('sources:');
    transcriptLines.push(...sourceList.map((source) => `- ${source}`));
  } else {
    transcriptLines.push('sources: none returned');
  }

  return {
    name: 'web_search',
    toolCallId,
    transcript: `@@tool\tweb_search\tWebSearch(${compactTextForHeader(queryText, 72)})\n${transcriptLines.join('\n')}`,
    historyNotice: [
      'Built-in web_search executed.',
      `query: ${queryText}`,
      sourceList.length > 0 ? `sources: ${sourceList.join(', ')}` : 'sources: none returned'
    ].join('\n')
  };
}

function readWebSearchOutput(value: unknown):
  | {
      action?: { type?: string; query?: string };
      sources?: Array<{ type: string; url?: string; name?: string }>;
    }
  | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as {
    action?: { type?: string; query?: string };
    sources?: Array<{ type: string; url?: string; name?: string }>;
  };
  return candidate;
}

function buildAiSdkTools(
  toolDefinitions: readonly ToolDefinition[],
  provider: ReturnType<typeof createOpenAI>,
  webSearchMode: 'disabled' | 'cached' | 'live'
) {
  const tools = Object.fromEntries(
    toolDefinitions.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.parameters),
      })
    ])
  );

  if (webSearchMode === 'disabled') {
    return tools;
  }

  return {
    ...tools,
    web_search: provider.tools.webSearch({
      externalWebAccess: webSearchMode === 'live',
      searchContextSize: 'medium'
    })
  };
}

function formatToolOutput(name: string, rawArguments: string, output: string): string {
  // TODO: spill oversized tool results to disk and replace them with a short inline pointer.
  return `@@tool\t${name}\t${formatToolHeader(name, rawArguments)}\n${clampText(output, 2400)}`;
}

function formatToolHeader(name: string, rawArguments: string): string {
  const args = parseArguments(rawArguments);

  switch (name) {
    case 'bash':
      return `Bash(${compactTextForHeader(readStringArg(args, 'command'), 72)})`;
    case 'read':
      return formatReadHeader(
        readStringArg(args, 'path'),
        readOptionalNumberArg(args, 'startLine'),
        readOptionalNumberArg(args, 'endLine')
      );
    case 'ls':
      return `Ls(${readOptionalStringArg(args, 'path') ?? '.'})`;
    case 'write':
      return `Write(${readStringArg(args, 'path')})`;
    case 'edit':
      return `Edit(${readStringArg(args, 'path')})`;
    case 'glob':
      return `Glob(${readStringArg(args, 'pattern')})`;
    case 'rg': {
      const target = readOptionalStringOrArrayArg(args, 'target');
      const targetText = Array.isArray(target) ? target.join(' ') : target;
      return target
        ? `Rg(${readStringArg(args, 'pattern')} in ${targetText})`
        : `Rg(${readStringArg(args, 'pattern')})`;
    }
    case 'grep': {
      const target = readOptionalStringOrArrayArg(args, 'target');
      const targetText = Array.isArray(target) ? target.join(' ') : target;
      return target
        ? `Rg(${readStringArg(args, 'pattern')} in ${targetText})`
        : `Rg(${readStringArg(args, 'pattern')})`;
    }
    case 'web_search': {
      const query = readOptionalStringArg(args, 'query');
      return query ? `WebSearch(${compactTextForHeader(query, 64)})` : 'WebSearch';
    }
    case 'spawn_experiment': {
      const questionId =
        readOptionalStringArg(args, 'questionId') ?? readOptionalStringArg(args, 'studyDebtId');
      return questionId
        ? `experiment spawn(${questionId}: ${compactTextForHeader(readStringArg(args, 'hypothesis'), 52)})`
        : `experiment spawn(${compactTextForHeader(readStringArg(args, 'hypothesis'), 64)})`;
    }
    case 'read_experiment':
      return `experiment read(${readStringArg(args, 'experimentId')})`;
    case 'wait_experiment':
      return `experiment wait(${readStringArg(args, 'experimentId')})`;
    case 'search_experiments': {
      const query = readOptionalStringArg(args, 'query');
      return query ? `experiment search(${compactTextForHeader(query, 56)})` : 'experiment search()';
    }
    case 'open_question':
    case 'open_study_debt':
      return `open question(${compactTextForHeader(readStringArg(args, 'summary'), 56)})`;
    case 'resolve_question':
    case 'resolve_study_debt':
      return `resolve question(${readOptionalStringArg(args, 'questionId') ?? readStringArg(args, 'debtId')})`;
    case 'extend_experiment_budget':
      return `experiment budget(${readStringArg(args, 'experimentId')})`;
    case 'resolve_experiment':
      return `experiment resolve(${readStringArg(args, 'experimentId')})`;
    case 'compact':
      return `Compact(${compactTextForHeader(readStringArg(args, 'goal'), 56)})`;
    default:
      return name;
  }
}

function formatLiveToolBody(name: string, rawArguments: string): string[] {
  const args = parseArguments(rawArguments);

  switch (name) {
    case 'bash':
      return [`command: ${readStringArg(args, 'command')}`];
    case 'read': {
      const path = readStringArg(args, 'path');
      const startLine = readOptionalNumberArg(args, 'startLine');
      const endLine = readOptionalNumberArg(args, 'endLine');
      const range =
        typeof startLine === 'number' || typeof endLine === 'number'
          ? `lines ${typeof startLine === 'number' ? Math.floor(startLine) : 1}-${typeof endLine === 'number' ? Math.floor(endLine) : 'end'}`
          : null;
      return range ? [`path: ${path}`, range] : [`path: ${path}`];
    }
    case 'ls':
      return [`path: ${readOptionalStringArg(args, 'path') ?? '.'}`];
    case 'write':
    case 'edit':
      return [`path: ${readStringArg(args, 'path')}`];
    case 'glob':
      return [`pattern: ${readStringArg(args, 'pattern')}`];
    case 'rg':
    case 'grep': {
      const pattern = readStringArg(args, 'pattern');
      const target = readOptionalStringOrArrayArg(args, 'target');
      const targetText = Array.isArray(target) ? target.join(' ') : target;
      return targetText ? [`pattern: ${pattern}`, `target: ${targetText}`] : [`pattern: ${pattern}`];
    }
    case 'web_search': {
      const query = readOptionalStringArg(args, 'query');
      return query ? [`query: ${query}`] : [];
    }
    default:
      return formatJsonArgumentPreview(args);
  }
}

function formatJsonArgumentPreview(args: Record<string, unknown>): string[] {
  if (Object.keys(args).length === 0) {
    return [];
  }

  const pretty = JSON.stringify(args, null, 2);
  if (!pretty) {
    return [];
  }

  const lines = pretty.split('\n');
  if (lines.length <= 4) {
    return lines;
  }

  return [...lines.slice(0, 4), `… ${lines.length - 4} more line(s)`];
}

function compactTextForHeader(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function formatReadHeader(path: string, startLine?: number, endLine?: number): string {
  if (typeof startLine === 'number' && typeof endLine === 'number') {
    return `Read(${path}:${Math.floor(startLine)}-${Math.floor(endLine)})`;
  }

  if (typeof startLine === 'number') {
    return `Read(${path}:${Math.floor(startLine)}-)`;
  }

  if (typeof endLine === 'number') {
    return `Read(${path}:1-${Math.floor(endLine)})`;
  }

  return `Read(${path})`;
}

function estimateHistoryItemTokens(item: ModelHistoryItem): number {
  if (item.type === 'message') {
    return estimateTokens(item.content);
  }

  if (item.type === 'function_call') {
    return estimateTokens(item.name) + estimateTokens(item.arguments);
  }

  return estimateTokens(item.output);
}

function getModelContextWindow(model: string): number {
  const configured = process.env.H2_CONTEXT_WINDOW_TOKENS;
  if (configured) {
    const parsed = Number.parseInt(configured, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const normalized = model.trim().toLowerCase();

  if (normalized === 'gpt-5.4' || normalized === 'gpt-5.4-pro') {
    return 1_050_000;
  }

  if (normalized === 'gpt-5.4-mini') {
    return 400_000;
  }

  if (normalized === 'gpt-5-codex' || normalized === 'gpt-5.3-codex') {
    return 272_000;
  }

  return 272_000;
}

function getModelStandardRateThreshold(model: string): number | null {
  const normalized = model.trim().toLowerCase();

  if (normalized === 'gpt-5.4' || normalized === 'gpt-5.4-pro') {
    return 272_000;
  }

  return null;
}

function normalizeReasoningEffort(value: string | undefined): 'low' | 'medium' | 'high' | null {
  if (!value) {
    return null;
  }

  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }

  return null;
}

function normalizeMaxModelSteps(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function debugResponseShape(
  sessionId: string,
  kind: string,
  payload: unknown
): Promise<void> {
  if (!DEBUG_RESPONSES_ENABLED) {
    return;
  }

  const dir = path.dirname(DEBUG_RESPONSES_FILE);
  await mkdir(dir, { recursive: true });
  await appendFile(
    DEBUG_RESPONSES_FILE,
    JSON.stringify(
      {
        timestamp: nowIso(),
        sessionId,
        kind,
        payload
      },
      null,
      0
    ) + '\n',
    'utf8'
  );
}

function shouldInjectExperimentHint(
  inputText: string,
  requestItems: ModelHistoryItem[],
  toolDefinitions: readonly ToolDefinition[]
): boolean {
  if (!toolDefinitions.some((tool) => tool.name === 'spawn_experiment')) {
    return false;
  }

  const functionCalls = getCurrentTurnFunctionCalls(requestItems);
  const inlineProbeCalls = getInlineProbeCalls(functionCalls);
  if (inlineProbeCalls.length < 6) {
    return false;
  }

  if (functionCalls.some((item) => item.name === 'spawn_experiment')) {
    return false;
  }

  if (functionCalls.some((item) => ['write', 'edit'].includes(item.name))) {
    return false;
  }

  return (
    appearsStudyableByExperiment(inputText, inlineProbeCalls) &&
    isCirclingRiskArea(inlineProbeCalls)
  );
}

function shouldInjectEarlyStudyOpportunityHint(
  inputText: string,
  requestItems: ModelHistoryItem[],
  toolDefinitions: readonly ToolDefinition[]
): boolean {
  if (!toolDefinitions.some((tool) => tool.name === 'spawn_experiment')) {
    return false;
  }

  const functionCalls = getCurrentTurnFunctionCalls(requestItems);
  if (functionCalls.some((item) => item.name === 'spawn_experiment')) {
    return false;
  }

  if (functionCalls.some((item) => ['write', 'edit'].includes(item.name))) {
    return false;
  }

  if (functionCalls.some((item) => ['open_question', 'open_study_debt'].includes(item.name))) {
    return false;
  }

  const inlineProbeCalls = getInlineProbeCalls(functionCalls);
  if (inlineProbeCalls.length < 4) {
    return false;
  }

  if (!appearsStudyableByExperiment(inputText, inlineProbeCalls)) {
    return false;
  }

  return inlineProbeCalls.length >= 5 || isCirclingRiskArea(inlineProbeCalls);
}

function shouldInjectPreEditGuardHint(requestItems: ModelHistoryItem[]): boolean {
  const functionCalls = getCurrentTurnFunctionCalls(requestItems);
  const currentTurnItems = getCurrentTurnItems(requestItems);

  const lastCall = functionCalls.at(-1);
  if (!lastCall || !['write', 'edit'].includes(lastCall.name)) {
    return false;
  }

  if (functionCalls.some((item) => item.name === 'spawn_experiment')) {
    return false;
  }

  if (functionCalls.some((item) => ['open_question', 'open_study_debt'].includes(item.name))) {
    return false;
  }

  if (functionCalls.some((item) => ['resolve_question', 'resolve_study_debt'].includes(item.name))) {
    return false;
  }

  const usedProviderWebSearch = currentTurnItems.some(
    (item) =>
      item.type === 'message' &&
      item.role === 'developer' &&
      item.content.startsWith('Built-in web_search executed.')
  );

  const investigationCalls = getInlineProbeCalls(functionCalls.slice(0, -1));

  if (usedProviderWebSearch) {
    return true;
  }

  return investigationCalls.length >= 5 && isCirclingRiskArea(investigationCalls);
}

function shouldInjectPostSpawnWaitHint(requestItems: ModelHistoryItem[]): boolean {
  const functionCalls = getCurrentTurnFunctionCalls(requestItems);
  const lastSpawnIndex = functionCalls.map((item) => item.name).lastIndexOf('spawn_experiment');
  if (lastSpawnIndex === -1) {
    return false;
  }

  const afterSpawn = functionCalls.slice(lastSpawnIndex + 1);
  if (afterSpawn.some((item) => item.name === 'wait_experiment')) {
    return false;
  }

  const repeatedInlineProbing = afterSpawn.filter((item) =>
    ['bash', 'read', 'ls', 'glob', 'rg', 'grep'].includes(item.name)
  ).length;

  return repeatedInlineProbing >= 3;
}

function shouldInjectObservationHint(
  requestItems: ModelHistoryItem[],
  toolDefinitions: readonly ToolDefinition[]
): boolean {
  if (!toolDefinitions.some((tool) => tool.name === 'log_observation')) {
    return false;
  }

  const functionCalls = getCurrentTurnFunctionCalls(requestItems);
  const lastObservationIndex = functionCalls.map((item) => item.name).lastIndexOf('log_observation');
  const sinceLastObservation =
    lastObservationIndex === -1 ? functionCalls : functionCalls.slice(lastObservationIndex + 1);

  if (sinceLastObservation.some((item) => item.name === 'resolve_experiment')) {
    return false;
  }

  const substantiveToolCalls = sinceLastObservation.filter(
    (item) => !['log_observation', 'read_experiment'].includes(item.name)
  ).length;

  return substantiveToolCalls >= 4;
}

function getCurrentTurnItems(requestItems: ModelHistoryItem[]): ModelHistoryItem[] {
  for (let index = requestItems.length - 1; index >= 0; index -= 1) {
    const item = requestItems[index];
    if (item?.type === 'message' && item.role === 'user') {
      return requestItems.slice(index + 1);
    }
  }

  return requestItems;
}

function getCurrentTurnFunctionCalls(
  requestItems: ModelHistoryItem[]
): Array<Extract<ModelHistoryItem, { type: 'function_call' }>> {
  return getCurrentTurnItems(requestItems).filter(
    (item): item is Extract<ModelHistoryItem, { type: 'function_call' }> => item.type === 'function_call'
  );
}

function getInlineProbeCalls(
  functionCalls: Array<Extract<ModelHistoryItem, { type: 'function_call' }>>
): Array<Extract<ModelHistoryItem, { type: 'function_call' }>> {
  return functionCalls.filter((item) => ['bash', 'read', 'ls', 'glob', 'rg', 'grep'].includes(item.name));
}

function appearsStudyableByExperiment(
  inputText: string,
  inlineProbeCalls: Array<Extract<ModelHistoryItem, { type: 'function_call' }>>
): boolean {
  const combinedSignals = [
    inputText,
    ...inlineProbeCalls.map((item) => getStudySignalText(item))
  ].join('\n');

  const strongLifecycleOnly =
    /(process death|main process dies|kill the harness|restart the harness|app shutdown|startup reconciliation|rehydrat|supervisor)/i.test(
      combinedSignals
    );
  if (strongLifecycleOnly) {
    return false;
  }

  return hasRiskSignal(combinedSignals);
}

function isCirclingRiskArea(
  inlineProbeCalls: Array<Extract<ModelHistoryItem, { type: 'function_call' }>>
): boolean {
  const focusCounts = new Map<string, number>();
  let riskySignalCount = 0;

  for (const call of inlineProbeCalls) {
    const signal = getStudySignalText(call);
    if (signal && hasRiskSignal(signal)) {
      riskySignalCount += 1;
    }

    const focusKey = getStudyFocusKey(call);
    if (!focusKey) {
      continue;
    }
    focusCounts.set(focusKey, (focusCounts.get(focusKey) ?? 0) + 1);
  }

  return riskySignalCount >= 3 || Array.from(focusCounts.values()).some((count) => count >= 2);
}

function hasRiskSignal(text: string): boolean {
  return /(auth|session|login|register|redirect|cookie|continu|ownership|migrat|transfer|persist|cache|invalidat|provider|fallback|stream|retry|integrat|dependency|compat|isolat|concurr|runtime|behavior|safely|without breaking|actually correct|state|uncertainty|evidence|repro|worktree|background|artifact|autosave|draft)/i.test(
    text
  );
}

function getStudySignalText(
  call: Extract<ModelHistoryItem, { type: 'function_call' }>
): string {
  const args = parseArguments(call.arguments);

  switch (call.name) {
    case 'read':
      return readOptionalStringArg(args, 'path') ?? '';
    case 'ls':
      return readOptionalStringArg(args, 'path') ?? '.';
    case 'rg':
    case 'grep':
      return [readOptionalStringArg(args, 'pattern'), readOptionalStringArg(args, 'target')]
        .filter(Boolean)
        .join(' ');
    case 'glob':
      return readOptionalStringArg(args, 'pattern') ?? '';
    case 'bash':
      return readOptionalStringArg(args, 'command') ?? '';
    default:
      return '';
  }
}

function getStudyFocusKey(
  call: Extract<ModelHistoryItem, { type: 'function_call' }>
): string | null {
  const args = parseArguments(call.arguments);

  if (call.name === 'read') {
    return normalizeFocusKey(readOptionalStringArg(args, 'path'));
  }

  if (call.name === 'ls') {
    return normalizeFocusKey(readOptionalStringArg(args, 'path'));
  }

  if (call.name === 'rg' || call.name === 'grep') {
    return normalizeFocusKey(readOptionalStringArg(args, 'target') ?? readOptionalStringArg(args, 'pattern'));
  }

  if (call.name === 'glob') {
    return normalizeFocusKey(readOptionalStringArg(args, 'pattern'));
  }

  if (call.name === 'bash') {
    const command = readOptionalStringArg(args, 'command');
    if (!command) {
      return null;
    }

    const match = command.match(
      /(playwright|curl|next|npm|pnpm|yarn|bun|vitest|jest|test|build|dev|auth|session|login|register|redirect|cookie|cache|stream|provider|retry)/i
    );
    return match ? match[1]!.toLowerCase() : null;
  }

  return null;
}

function normalizeFocusKey(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const cleaned = value.trim().replace(/\\/g, '/');
  if (!cleaned) {
    return null;
  }

  if (cleaned.includes('/')) {
    const segments = cleaned.split('/').filter(Boolean).slice(0, 2);
    return segments.length > 0 ? segments.join('/') : null;
  }

  return cleaned.toLowerCase();
}

function buildEarlyStudyOpportunityHint(): string {
  return [
    'Harness hint:',
    'You likely have enough context to launch one bounded study now.',
    'If this uncertainty could change the implementation choice and there is known-safe work you can continue in parallel, spawn the study early instead of waiting until you are blocked.',
    'Keep the study narrow, concrete, and falsifiable.'
  ].join(' ');
}

function buildExperimentHint(): string {
  return [
    'Harness hint:',
    'You are still circling a studyable uncertainty inline without yet launching a bounded study.',
    'If spawn_experiment can settle this more cheaply than more background probing, run one narrow study now.',
    'Prefer a concrete falsifier over more read/rg churn.'
  ].join(' ');
}

function buildPreEditGuardHint(): string {
  return [
    'Harness hint:',
    'You investigated this plan for a while and are now moving toward implementation.',
    'If external docs or web search materially shaped the protocol, backend, provider, or runtime path, track that as a current question before editing through it.',
    'If dependent edits still rely on unresolved load-bearing uncertainty, declare or resolve an open question before editing through it.',
    'Either open a question, justify why static evidence is sufficient, or explicitly narrow scope before editing dependent code.'
  ].join(' ');
}

function buildPostSpawnWaitHint(): string {
  return [
    'Harness hint:',
    'You already have a live experiment on this hypothesis.',
    'If this experiment is the main evidence source for the current question, wait for it to resolve before editing on that same question.',
    'Prefer wait_experiment or one small external-observer corroboration check over continued background reading or probing about the same question.',
    'Use read_experiment only if you need the full durable record rather than a lightweight live status check.'
  ].join(' ');
}

function buildObservationHint(): string {
  return [
    'Harness hint:',
    'You have made several tool calls in this experiment without logging a fresh observation.',
    'Record a concrete finding, blocker, changed belief, or current dead-end now.',
    'Do not log routine activity; log the evidence or obstacle that actually matters.'
  ].join(' ');
}

function normalizeExperimentWaitTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return 5_000;
  }

  if (!Number.isFinite(timeoutMs)) {
    return 5_000;
  }

  return Math.max(3_000, Math.floor(timeoutMs));
}

export const MAIN_TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'bash',
    description:
      'Run a shell command in the current workspace. Prefer this for direct repo inspection, tiny inline probes, targeted tests, or other checks that are cheaper to answer inline than by spawning a bounded experiment. If the command is a live external or secret-backed runtime probe whose result could materially change the implementation, declare an open question first.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' }
      },
      required: ['command'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'read',
    description:
      'Read a specific file from the workspace. By default, returns the first 100 lines. Use startLine and endLine for targeted slices when you need a different range; avoid broad file dumping when a smaller read would do.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'number' },
        endLine: { type: 'number' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'ls',
    description: 'List a directory in the workspace. Use this for quick orientation before broader globbing or searching.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'edit',
    description: 'Replace the first matching text fragment in a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        findText: { type: 'string' },
        replaceText: { type: 'string' }
      },
      required: ['path', 'findText', 'replaceText'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'glob',
    description:
      'Find files using a glob pattern. Keep patterns narrow and purposeful; avoid broad scans of generated output, dependency directories, or node_modules unless they are directly relevant.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' }
      },
      required: ['pattern'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'rg',
    description:
      'Search files for a text pattern. Prefer targeted paths or symbols over repo-wide fishing, and avoid searching dependency trees unless the question specifically depends on them.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        target: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
        }
      },
      required: ['pattern'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'spawn_experiment',
    description:
      'Run a scoped experiment in a separate git worktree. Use this when the uncertainty is load-bearing and a bounded disposable study is the cheapest reliable way to answer the residual uncertainty after a focused local evidence pass. Do not use it to repeat the same local inspection the main thread can already perform directly. If an open question exists, this experiment must be tied to that question via questionId and should test the single residual uncertainty that static inspection has not settled yet, not restate the whole implementation plan. localEvidenceSummary should say what the focused local pass already established. residualUncertainty should name the one thing still unresolved that this experiment is meant to answer. If resolving the question requires a live external or secret-backed runtime probe and you can continue independent safe work in parallel, prefer spawning that probe as an experiment instead of blocking on it inline. If one focused local evidence pass is likely to settle the question directly, finish that pass before spawning. If inspection already settles the question, resolve it statically instead of spawning. If you do not have a strong reason to choose a smaller number, use a 50000 token budget.',
    parameters: {
      type: 'object',
      properties: {
        questionId: { type: 'string' },
        hypothesis: { type: 'string' },
        localEvidenceSummary: { type: 'string' },
        residualUncertainty: { type: 'string' },
        context: { type: 'string' },
        budgetTokens: { type: 'number' },
        preserve: { type: 'boolean' }
      },
      required: ['hypothesis', 'localEvidenceSummary', 'residualUncertainty'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'extend_experiment_budget',
    description: 'Add more estimated tokens to a paused or running experiment budget.',
    parameters: {
      type: 'object',
      properties: {
        experimentId: { type: 'string' },
        additionalTokens: { type: 'number' }
      },
      required: ['experimentId', 'additionalTokens'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'read_experiment',
    description:
      'Read the full durable record for a previously spawned experiment, including observations and final details. Prefer wait_experiment for routine live checks while an experiment is still running.',
    parameters: {
      type: 'object',
      properties: {
        experimentId: { type: 'string' }
      },
      required: ['experimentId'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'wait_experiment',
    description:
      'Wait for a running experiment to resolve, up to a bounded timeout in milliseconds. This is the default follow-up after spawning when the experiment is the main evidence source. If timeoutMs is omitted, a longer default wait is used; very short waits are rounded up.',
    parameters: {
      type: 'object',
      properties: {
        experimentId: { type: 'string' },
        timeoutMs: { type: 'number' }
      },
      required: ['experimentId'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'search_experiments',
    description:
      'Search prior experiment history for evidence relevant to the current question. Do not use this as ad hoc memory lookup or precedent fishing. First articulate the live question, explicitly say why no question is needed, or resume a previously opened question; then search for prior findings that may answer or narrow that current uncertainty.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'open_question',
    description:
      'Declare an unresolved, load-bearing open question before editing code that depends on it. Use this when being wrong could materially change the implementation choice. Choose the question that would most change the architecture, state model, runtime behavior, protocol handling, recovery semantics, or continuity assumptions if answered differently. Do not spend an open question on a quick framework or library capability check that one focused local read, doc slice, or tiny inline probe can settle immediately unless that capability is the true blocker. If the only way to answer the uncertainty is a live external or secret-backed runtime probe, open the question first even if you expect the probe to be quick. Once declared, dependent main-workspace edits are blocked until the question is resolved. Opening a question does not require an experiment; you can resolve it with quick static evidence, a small inline probe, or a bounded study.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        whyItMatters: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['runtime', 'scope', 'architecture']
        },
        affectedPaths: {
          type: 'array',
          items: { type: 'string' }
        },
        recommendedStudy: { type: 'string' }
      },
      required: ['summary', 'whyItMatters'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'resolve_question',
    description:
      'Resolve a previously opened question once it has been answered by running a study, justifying static evidence, narrowing scope, or honoring a user override.',
    parameters: {
      type: 'object',
      properties: {
        questionId: { type: 'string' },
        resolution: {
          type: 'string',
          enum: ['study_run', 'static_evidence_sufficient', 'scope_narrowed', 'user_override']
        },
        note: { type: 'string' }
      },
      required: ['questionId', 'resolution', 'note'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'compact',
    description: 'Checkpoint current state before context compression.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        completed: { type: 'string' },
        next: { type: 'string' },
        openRisks: { type: 'string' }
      },
      required: ['goal', 'completed', 'next'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'resolve_experiment',
    description:
      'Resolve an experiment with a final verdict, summary, and any important findings, artifacts, constraints, or confidence notes.',
    parameters: {
      type: 'object',
      properties: {
        experimentId: { type: 'string' },
        verdict: {
          type: 'string',
          enum: ['validated', 'invalidated', 'inconclusive']
        },
        summary: { type: 'string' },
        discovered: {
          type: 'array',
          items: { type: 'string' }
        },
        artifacts: {
          type: 'array',
          items: { type: 'string' }
        },
        constraints: {
          type: 'array',
          items: { type: 'string' }
        },
        confidenceNote: { type: 'string' },
        promote: { type: 'boolean' }
      },
      required: ['experimentId', 'verdict', 'summary'],
      additionalProperties: false
    }
  }
] as const;

export const EXPERIMENT_TOOL_DEFINITIONS = [
  MAIN_TOOL_DEFINITIONS[0],
  MAIN_TOOL_DEFINITIONS[1],
  MAIN_TOOL_DEFINITIONS[2],
  MAIN_TOOL_DEFINITIONS[3],
  MAIN_TOOL_DEFINITIONS[4],
  MAIN_TOOL_DEFINITIONS[5],
  {
    type: 'function',
    name: 'log_observation',
    description: 'Append a timestamped observation to the current experiment.',
    parameters: {
      type: 'object',
      properties: {
        experimentId: { type: 'string' },
        message: { type: 'string' },
        tags: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['promising', 'discovery', 'blocker', 'question', 'conclusion']
          }
        }
      },
      required: ['experimentId', 'message'],
      additionalProperties: false
    }
  },
  MAIN_TOOL_DEFINITIONS[8],
  {
    type: 'function',
    name: 'resolve_experiment',
    description:
      'Resolve the current experiment with a verdict, summary, and any important findings, artifacts, constraints, or confidence notes.',
    parameters: {
      type: 'object',
      properties: {
        experimentId: { type: 'string' },
        verdict: {
          type: 'string',
          enum: ['validated', 'invalidated', 'inconclusive']
        },
        summary: { type: 'string' },
        discovered: {
          type: 'array',
          items: { type: 'string' }
        },
        artifacts: {
          type: 'array',
          items: { type: 'string' }
        },
        constraints: {
          type: 'array',
          items: { type: 'string' }
        },
        confidenceNote: { type: 'string' },
        promote: { type: 'boolean' }
      },
      required: ['experimentId', 'verdict', 'summary'],
      additionalProperties: false
    }
  }
] as const;

export function createSessionHeader(): string {
  return `h2_${randomUUID()}`;
}
