import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { stepCountIs, streamText, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { OPENAI_CODEX_ORIGINATOR, OpenAICodexAuth } from '../auth/openai-codex.js';
import { clampText, estimateTokens, nowIso } from '../lib/utils.js';
import { EXPERIMENT_SUBAGENT_PROMPT, MAIN_AGENT_PROMPT } from './codex-prompt.js';
import { Notebook } from '../storage/notebook.js';
import {
  buildEarlyStudyOpportunityHint,
  buildExperimentHint,
  buildObservationHint,
  buildPostSpawnWaitHint,
  buildPreEditGuardHint,
  shouldInjectEarlyStudyOpportunityHint,
  shouldInjectExperimentHint,
  shouldInjectObservationHint,
  shouldInjectPostSpawnWaitHint,
  shouldInjectPreEditGuardHint
} from './codex-hints.js';
import {
  buildAiSdkTools,
  executeToolCallBatch,
  formatLiveToolBody,
  formatToolHeader,
  formatToolOutput,
  isParallelReadOnlyToolCall,
  MAIN_TOOL_DEFINITIONS,
  normalizeExperimentWaitTimeout,
  parseArguments,
  type ToolCall,
  type ToolDefinition
} from './codex-tooling.js';
import type {
  AgentTools,
  ModelHistoryItem,
  ModelSessionRecord,
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

export { EXPERIMENT_TOOL_DEFINITIONS, MAIN_TOOL_DEFINITIONS } from './codex-tooling.js';

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

interface ContextWindowUsage {
  usedTokens: number;
  totalTokens: number;
  standardRateTokens: number | null;
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
  const transcriptLines = query ? [`query: ${query}`] : [];
  if (sourceList.length > 0) {
    transcriptLines.push('sources:');
    transcriptLines.push(...sourceList.map((source) => `- ${source}`));
  } else {
    transcriptLines.push('sources: none returned');
  }
  const header = query ? `WebSearch(${compactTextForHeader(query, 72)})` : 'WebSearch';

  return {
    name: 'web_search',
    toolCallId,
    transcript: `@@tool\tweb_search\t${header}\n${transcriptLines.join('\n')}`,
    historyNotice: ['Built-in web_search executed.', ...transcriptLines].join('\n')
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

export function createSessionHeader(): string {
  return `h2_${randomUUID()}`;
}
