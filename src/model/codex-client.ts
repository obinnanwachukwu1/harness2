import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

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

interface CodexModelClientOptions {
  fetchImpl?: typeof fetch;
  endpoint?: string;
  model?: string;
}

interface ResponseItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string | { value?: string } }>;
  summary?: Array<{ type?: string; text?: string | { value?: string }; summary_text?: string }>;
}

interface ResponsePayload {
  id?: string;
  output?: ResponseItem[];
  output_text?: string;
  reasoning_summary?: string;
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
}

interface ToolExecutionResult {
  output: string;
  failed: boolean;
}

export class CodexModelClient {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly defaultModel: string;

  constructor(
    private readonly notebook: Notebook,
    private readonly auth: OpenAICodexAuth,
    options: CodexModelClientOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.defaultModel = options.model ?? DEFAULT_MODEL;
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
    instructions = MAIN_AGENT_PROMPT
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
        previousResponseId,
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
        instructions
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

      const toolCalls = extractToolCalls(response);
      const assistantText = extractAssistantText(response);
      const reasoningSummary = thinkingEnabled ? extractReasoningSummary(response) : '';

      if (reasoningSummary) {
        await onReasoningSummaryStream?.(reasoningSummary);
        await emit('system', `@@thinking\t${reasoningSummary}`);
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
            outputTypes: (response.output ?? []).map((item) => item.type ?? '(missing)'),
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

      for (const call of toolCalls) {
        const result = await executeToolCallSafely(call, tools);
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
        await emit(
          'tool',
          formatToolOutput(
            call.name,
            call.rawArguments,
            result.failed ? `${result.output}\nTool execution failed.` : result.output
          )
        );
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
      totalTokens: getModelContextWindow(settings.model)
    };
  }

  private async createResponse(input: {
    accessToken: string;
    accountId: string;
    sessionId: string;
    previousResponseId: string | null;
    settings: ModelSessionRecord;
    input: unknown;
    onAssistantStream?: (text: string) => Promise<void>;
    onReasoningSummaryStream?: (text: string) => Promise<void>;
    thinkingEnabled: boolean;
    toolDefinitions: readonly ToolDefinition[];
    instructions: string;
  }): Promise<ResponsePayload> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${input.accessToken}`,
      'content-type': 'application/json',
      originator: OPENAI_CODEX_ORIGINATOR,
      session_id: input.sessionId
    };

    if (input.accountId) {
      headers['chatgpt-account-id'] = input.accountId;
    }

    const body: Record<string, unknown> = {
      model: input.settings.model,
      instructions: input.instructions,
      input: input.input,
      tools: input.toolDefinitions,
      tool_choice: 'auto',
      prompt_cache_key: input.sessionId,
      store: false,
      stream: true
    };

    if (input.previousResponseId) {
      body.previous_response_id = input.previousResponseId;
    }

    const reasoning: Record<string, unknown> = {};
    if (input.settings.reasoningEffort) {
      reasoning.effort = input.settings.reasoningEffort;
    }
    if (input.thinkingEnabled) {
      reasoning.summary = 'auto';
    }
    if (Object.keys(reasoning).length > 0) {
      body.reasoning = reasoning;
    }

    await debugResponseShape(input.sessionId, 'request', {
      endpoint: this.endpoint,
      model: body.model,
      reasoning: body.reasoning ?? null,
      input: body.input,
      previous_response_id: body.previous_response_id ?? null,
      prompt_cache_key: body.prompt_cache_key ?? null
    });

    const response = await this.fetchWithRetries(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-oai-request-id');
      const details = await safeReadText(response);
      const suffix = requestId ? ` request_id=${requestId}` : '';
      throw new Error(
        `Model request failed: ${response.status} ${response.statusText}${suffix}\n${clampText(details, 1500)}`
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const payload = (await response.json()) as ResponsePayload;
      await debugResponseShape(input.sessionId, 'json_response', payload);
      return payload;
    }

    return readStreamingResponse(
      response,
      input.sessionId,
      input.onAssistantStream,
      input.onReasoningSummaryStream
    );
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
    case 'write':
      return tools.write(readStringArg(args, 'path'), readStringArg(args, 'content'));
    case 'edit':
      return tools.edit(
        readStringArg(args, 'path'),
        readStringArg(args, 'findText'),
        readStringArg(args, 'replaceText')
      );
    case 'glob':
      return JSON.stringify(await tools.glob(readStringArg(args, 'pattern')), null, 2);
    case 'grep':
      return tools.grep(readStringArg(args, 'pattern'), readOptionalStringArg(args, 'target'));
    case 'spawn_experiment': {
      const experiment = await tools.spawnExperiment({
        hypothesis: readStringArg(args, 'hypothesis'),
        context: readOptionalStringArg(args, 'context'),
        budgetTokens:
          readOptionalNumberArg(args, 'budgetTokens') ?? DEFAULT_EXPERIMENT_BUDGET_TOKENS,
        preserve: readOptionalBooleanArg(args, 'preserve') ?? false
      });
      return JSON.stringify(experiment, null, 2);
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
        await tools.readExperiment(readStringArg(args, 'experimentId')),
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
    case 'open_study_debt':
      if (!tools.openStudyDebt) {
        throw new Error('open_study_debt is not available in this session.');
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
    case 'resolve_study_debt':
      if (!tools.resolveStudyDebt) {
        throw new Error('resolve_study_debt is not available in this session.');
      }
      return JSON.stringify(
        await tools.resolveStudyDebt({
          debtId: readStringArg(args, 'debtId'),
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

function extractAssistantText(response: ResponsePayload): string {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const pieces: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'message') {
      continue;
    }
    for (const content of item.content ?? []) {
      const text = extractContentPartText(content);
      if (text) {
        pieces.push(text);
      }
    }
  }

  return pieces.join('\n').trim();
}

function extractReasoningSummary(response: ResponsePayload): string {
  if (typeof response.reasoning_summary === 'string' && response.reasoning_summary.trim()) {
    return response.reasoning_summary.trim();
  }

  const pieces: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'reasoning') {
      continue;
    }

    const summary = extractReasoningItemSummary(item);
    if (summary) {
      pieces.push(summary);
    }
  }

  return pieces.join('\n').trim();
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

function extractToolCalls(response: ResponsePayload): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'function_call') {
      continue;
    }

    if (!item.name || !item.call_id || typeof item.arguments !== 'string') {
      continue;
    }

    calls.push({
      name: item.name,
      callId: item.call_id,
      rawArguments: item.arguments
    });
  }
  return calls;
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
    case 'write':
      return `Write(${readStringArg(args, 'path')})`;
    case 'edit':
      return `Edit(${readStringArg(args, 'path')})`;
    case 'glob':
      return `Glob(${readStringArg(args, 'pattern')})`;
    case 'grep': {
      const target = readOptionalStringArg(args, 'target');
      return target
        ? `Grep(${readStringArg(args, 'pattern')} in ${target})`
        : `Grep(${readStringArg(args, 'pattern')})`;
    }
    case 'spawn_experiment':
      return `experiment spawn(${compactTextForHeader(readStringArg(args, 'hypothesis'), 64)})`;
    case 'read_experiment':
      return `experiment read(${readStringArg(args, 'experimentId')})`;
    case 'wait_experiment':
      return `experiment wait(${readStringArg(args, 'experimentId')})`;
    case 'search_experiments': {
      const query = readOptionalStringArg(args, 'query');
      return query ? `experiment search(${compactTextForHeader(query, 56)})` : 'experiment search()';
    }
    case 'open_study_debt':
      return `study debt open(${compactTextForHeader(readStringArg(args, 'summary'), 56)})`;
    case 'resolve_study_debt':
      return `study debt resolve(${readStringArg(args, 'debtId')})`;
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

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '(no response body)';
  }
}

async function readStreamingResponse(
  response: Response,
  sessionId: string,
  onAssistantStream?: (text: string) => Promise<void>,
  onReasoningSummaryStream?: (text: string) => Promise<void>
): Promise<ResponsePayload> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Streaming response did not include a body.');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let completed: ResponsePayload | null = null;
  let liveAssistantText = '';
  let liveReasoningSummary = '';
  const streamedOutputItems = new Map<string, ResponseItem>();

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const event = parseSseEvent(chunk);
      await debugResponseShape(
        sessionId,
        'sse_event',
        event
          ? {
              type: typeof event.type === 'string' ? event.type : '(missing)',
              event
            }
          : { type: '(unparsed)', chunk }
      );
      if (event?.type === 'error') {
        const errorPayload =
          event.error && typeof event.error === 'object'
            ? (event.error as { message?: unknown })
            : undefined;
        const message =
          typeof errorPayload?.message === 'string'
            ? errorPayload.message
            : 'Streaming response failed.';
        throw new Error(message);
      }

      const streamUpdate = extractStreamingTextUpdate(event);
      if (streamUpdate) {
        liveAssistantText = mergeStreamingText(liveAssistantText, streamUpdate);
        await onAssistantStream?.(liveAssistantText);
      }

      const reasoningUpdate = extractStreamingReasoningSummaryUpdate(event);
      if (reasoningUpdate) {
        liveReasoningSummary = mergeStreamingText(liveReasoningSummary, reasoningUpdate);
        await onReasoningSummaryStream?.(liveReasoningSummary);
      }

      collectStreamingOutputItem(event, streamedOutputItems);

      if (event?.type === 'response.completed' && event.response) {
        completed = event.response as ResponsePayload;
      }

      boundary = buffer.indexOf('\n\n');
    }
  }

  if (!completed) {
    throw new Error('Streaming response ended before response.completed.');
  }

  if ((!Array.isArray(completed.output) || completed.output.length === 0) && streamedOutputItems.size > 0) {
    completed.output = Array.from(streamedOutputItems.values());
  }

  if (!extractAssistantText(completed) && liveAssistantText.trim()) {
    completed.output_text = liveAssistantText.trim();
  }

  if (!extractReasoningSummary(completed) && liveReasoningSummary.trim()) {
    completed.reasoning_summary = liveReasoningSummary.trim();
  }

  await debugResponseShape(sessionId, 'completed_response', completed);

  return completed;
}

function extractStreamingTextUpdate(
  event: Record<string, unknown> | null
): { mode: 'append' | 'replace'; text: string } | null {
  if (!event || typeof event.type !== 'string') {
    return null;
  }

  if (event.type === 'response.output_text.delta' || event.type === 'response.text.delta') {
    return typeof event.delta === 'string' && event.delta.length > 0
      ? { mode: 'append', text: event.delta }
      : null;
  }

  if (event.type === 'response.content_part.added' || event.type === 'response.content_part.done') {
    const text = extractContentPartText(event.part) || extractContentPartText(event.content_part);
    return text ? { mode: 'replace', text } : null;
  }

  if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
    const text = extractOutputItemText(event.item);
    return text ? { mode: 'replace', text } : null;
  }

  return null;
}

function extractStreamingReasoningSummaryUpdate(
  event: Record<string, unknown> | null
): { mode: 'append' | 'replace'; text: string } | null {
  if (!event || typeof event.type !== 'string') {
    return null;
  }

  if (event.type === 'response.reasoning_summary_text.delta') {
    return typeof event.delta === 'string' && event.delta.length > 0
      ? { mode: 'append', text: event.delta }
      : null;
  }

  if (event.type === 'response.reasoning_summary_text.done') {
    const text =
      typeof event.text === 'string'
        ? event.text
        : typeof event.delta === 'string'
          ? event.delta
          : '';
    return text ? { mode: 'replace', text } : null;
  }

  if (event.type === 'response.reasoning_summary_part.added' || event.type === 'response.reasoning_summary_part.done') {
    const text = extractReasoningSummaryPartText(event.part) || extractReasoningSummaryPartText(event.summary_part);
    return text ? { mode: 'replace', text } : null;
  }

  if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
    const text = extractReasoningItemSummary(event.item);
    return text ? { mode: 'replace', text } : null;
  }

  return null;
}

function mergeStreamingText(
  current: string,
  update: { mode: 'append' | 'replace'; text: string }
): string {
  if (update.mode === 'append') {
    return current + update.text;
  }

  if (!current) {
    return update.text;
  }

  if (update.text === current) {
    return current;
  }

  if (update.text.startsWith(current)) {
    return update.text;
  }

  if (current.startsWith(update.text)) {
    return current;
  }

  return update.text;
}

function extractContentPartText(part: unknown): string {
  if (!part || typeof part !== 'object') {
    return '';
  }

  const contentPart = part as { type?: unknown; text?: unknown };
  if (contentPart.type !== 'output_text' && contentPart.type !== 'text') {
    return '';
  }

  if (typeof contentPart.text === 'string') {
    return contentPart.text;
  }

  if (
    contentPart.text &&
    typeof contentPart.text === 'object' &&
    'value' in contentPart.text &&
    typeof (contentPart.text as { value?: unknown }).value === 'string'
  ) {
    return (contentPart.text as { value: string }).value;
  }

  return '';
}

function extractOutputItemText(item: unknown): string {
  if (!item || typeof item !== 'object') {
    return '';
  }

  const outputItem = item as { type?: unknown; content?: unknown };
  if (outputItem.type !== 'message' || !Array.isArray(outputItem.content)) {
    return '';
  }

  const pieces = outputItem.content
    .map((part) => extractContentPartText(part))
    .filter((part) => part.length > 0);

  return pieces.join('');
}

function extractReasoningItemSummary(item: unknown): string {
  if (!item || typeof item !== 'object') {
    return '';
  }

  const outputItem = item as { type?: unknown; summary?: unknown };
  if (outputItem.type !== 'reasoning' || !Array.isArray(outputItem.summary)) {
    return '';
  }

  const pieces = outputItem.summary
    .map((part) => extractReasoningSummaryPartText(part))
    .filter((part) => part.length > 0);

  return pieces.join('\n').trim();
}

function extractReasoningSummaryPartText(part: unknown): string {
  if (!part || typeof part !== 'object') {
    return '';
  }

  const record = part as { type?: unknown; text?: unknown; summary_text?: unknown };
  if (typeof record.text === 'string') {
    return record.text;
  }

  if (typeof record.summary_text === 'string') {
    return record.summary_text;
  }

  if (
    record.text &&
    typeof record.text === 'object' &&
    'value' in record.text &&
    typeof (record.text as { value?: unknown }).value === 'string'
  ) {
    return (record.text as { value: string }).value;
  }

  return '';
}

function collectStreamingOutputItem(
  event: Record<string, unknown> | null,
  streamedOutputItems: Map<string, ResponseItem>
): void {
  if (!event || typeof event.type !== 'string') {
    return;
  }

  if (event.type !== 'response.output_item.added' && event.type !== 'response.output_item.done') {
    return;
  }

  const item = normalizeResponseItem(event.item);
  if (!item || item.type === 'reasoning') {
    return;
  }

  const key = item.id ?? item.call_id ?? `${item.type}:${streamedOutputItems.size}`;
  streamedOutputItems.set(key, item);
}

function normalizeResponseItem(item: unknown): ResponseItem | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const record = item as Record<string, unknown>;
  const normalized: ResponseItem = {
    type: typeof record.type === 'string' ? record.type : undefined,
    id: typeof record.id === 'string' ? record.id : undefined,
    call_id: typeof record.call_id === 'string' ? record.call_id : undefined,
    name: typeof record.name === 'string' ? record.name : undefined,
    arguments: typeof record.arguments === 'string' ? record.arguments : undefined
  };

  if (Array.isArray(record.content)) {
    normalized.content = record.content
      .map((part) => normalizeContentPart(part))
      .filter((part): part is { type?: string; text?: string | { value?: string } } => Boolean(part));
  }

  if (Array.isArray(record.summary)) {
    normalized.summary = record.summary
      .map((part) => normalizeReasoningSummaryPart(part))
      .filter(
        (part): part is { type?: string; text?: string | { value?: string }; summary_text?: string } =>
          Boolean(part)
      );
  }

  return normalized;
}

function normalizeContentPart(
  part: unknown
): { type?: string; text?: string | { value?: string } } | null {
  if (!part || typeof part !== 'object') {
    return null;
  }

  const record = part as Record<string, unknown>;
  const normalized: { type?: string; text?: string | { value?: string } } = {
    type: typeof record.type === 'string' ? record.type : undefined
  };

  if (typeof record.text === 'string') {
    normalized.text = record.text;
  } else if (record.text && typeof record.text === 'object') {
    const textRecord = record.text as Record<string, unknown>;
    if (typeof textRecord.value === 'string') {
      normalized.text = { value: textRecord.value };
    }
  }

  return normalized;
}

function normalizeReasoningSummaryPart(
  part: unknown
): { type?: string; text?: string | { value?: string }; summary_text?: string } | null {
  if (!part || typeof part !== 'object') {
    return null;
  }

  const record = part as Record<string, unknown>;
  const normalized: { type?: string; text?: string | { value?: string }; summary_text?: string } = {
    type: typeof record.type === 'string' ? record.type : undefined
  };

  if (typeof record.text === 'string') {
    normalized.text = record.text;
  } else if (record.text && typeof record.text === 'object') {
    const textRecord = record.text as Record<string, unknown>;
    if (typeof textRecord.value === 'string') {
      normalized.text = { value: textRecord.value };
    }
  }

  if (typeof record.summary_text === 'string') {
    normalized.summary_text = record.summary_text;
  }

  return normalized;
}

function parseSseEvent(chunk: string): Record<string, unknown> | null {
  const dataLines = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    return null;
  }

  const data = dataLines.join('\n');
  if (data === '[DONE]') {
    return null;
  }

  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
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

  if (functionCalls.some((item) => item.name === 'open_study_debt')) {
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

  const lastCall = functionCalls.at(-1);
  if (!lastCall || !['write', 'edit'].includes(lastCall.name)) {
    return false;
  }

  if (functionCalls.some((item) => item.name === 'spawn_experiment')) {
    return false;
  }

  if (functionCalls.some((item) => item.name === 'open_study_debt')) {
    return false;
  }

  if (functionCalls.some((item) => item.name === 'resolve_study_debt')) {
    return false;
  }

  const investigationCalls = getInlineProbeCalls(functionCalls.slice(0, -1));

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
    ['bash', 'read', 'glob', 'grep'].includes(item.name)
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
  return functionCalls.filter((item) => ['bash', 'read', 'glob', 'grep'].includes(item.name));
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

  if (call.name === 'grep') {
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
    'Prefer a concrete falsifier over more read/grep churn.'
  ].join(' ');
}

function buildPreEditGuardHint(): string {
  return [
    'Harness hint:',
    'You investigated this plan for a while and are now moving toward implementation.',
    'If dependent edits still rely on unresolved load-bearing uncertainty, declare or discharge study debt before editing through it.',
    'Either open study debt, justify why static evidence is sufficient, or explicitly narrow scope before editing dependent code.'
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
      'Run a shell command in the current workspace. Prefer this for direct repo inspection, tiny inline probes, targeted tests, or other checks that are cheaper to answer inline than by spawning a bounded experiment.',
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
    name: 'write',
    description: 'Write a file in the workspace, creating parent directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content'],
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
    name: 'grep',
    description:
      'Search files for a text pattern. Prefer targeted paths or symbols over repo-wide fishing, and avoid searching dependency trees unless the question specifically depends on them.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        target: { type: 'string' }
      },
      required: ['pattern'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'spawn_experiment',
    description:
      'Run a scoped experiment in a separate git worktree. Use this when the uncertainty is load-bearing and can be reduced by a bounded disposable study. After a brief orientation pass, if you can state one concrete falsifiable experiment and there is known-safe work you can continue in parallel, prefer launching it early over more background gathering. If you do not have a strong reason to choose a smaller number, use a 50000 token budget.',
    parameters: {
      type: 'object',
      properties: {
        hypothesis: { type: 'string' },
        context: { type: 'string' },
        budgetTokens: { type: 'number' },
        preserve: { type: 'boolean' }
      },
      required: ['hypothesis'],
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
    description: 'Search prior experiment history by hypothesis, summary, or observations.',
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
    name: 'open_study_debt',
    description:
      'Declare unresolved, load-bearing uncertainty before editing code that depends on it. Use this when being wrong could materially change the implementation choice. Once declared, dependent main-workspace edits are blocked until the debt is discharged.',
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
    name: 'resolve_study_debt',
    description:
      'Discharge a previously opened study debt once it has been resolved by running a study, justifying static evidence, narrowing scope, or honoring a user override.',
    parameters: {
      type: 'object',
      properties: {
        debtId: { type: 'string' },
        resolution: {
          type: 'string',
          enum: ['study_run', 'static_evidence_sufficient', 'scope_narrowed', 'user_override']
        },
        note: { type: 'string' }
      },
      required: ['debtId', 'resolution', 'note'],
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
