import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { OpenAICodexAuth } from '../auth/openai-codex.js';
import { clampText, estimateTokens, nowIso } from '../lib/utils.js';
import { EXPERIMENT_SUBAGENT_PROMPT, MAIN_AGENT_PROMPT } from './codex-prompt.js';
import { Notebook } from '../storage/notebook.js';
import {
  buildObservationHint,
  shouldInjectObservationHint,
} from './codex-hints.js';
import {
  executeToolCallBatch,
  formatLiveToolBody,
  formatToolHeader,
  formatToolOutput,
  isParallelReadOnlyToolCall,
  MAIN_TOOL_DEFINITIONS,
  type ToolDefinition
} from './codex-tooling.js';
import {
  createModelStepResponse,
  type ModelStepResponse,
  type ProviderToolEvent,
  toResponseInputItem
} from './codex-response.js';
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
const MAX_TRANSIENT_MODEL_RETRIES = 2;
const DEBUG_RESPONSES_ENABLED = process.env.H2_DEBUG_RESPONSES === '1';
const DEBUG_RESPONSES_FILE =
  process.env.H2_DEBUG_RESPONSES_FILE ??
  path.join(process.cwd(), '.h2', 'debug', 'responses.jsonl');

export { EXPERIMENT_TOOL_DEFINITIONS, MAIN_TOOL_DEFINITIONS } from './codex-tooling.js';

interface CodexModelClientOptions {
  fetchImpl?: typeof fetch;
  endpoint?: string;
  model?: string;
}

interface ContextWindowUsage {
  usedTokens: number;
  totalTokens: number;
  standardRateTokens: number | null;
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
    webSearchMode: 'disabled' | 'cached' | 'live' | undefined = undefined,
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

    for (;;) {
      const hints = [
        shouldInjectObservationHint(requestItems, toolDefinitions) ? buildObservationHint() : null
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
        webSearchMode,
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
    input: Array<
      | { role: 'user' | 'assistant' | 'system' | 'developer'; content: string }
      | { type: 'function_call'; call_id: string; name: string; arguments: string }
      | { type: 'function_call_output'; call_id: string; output: string }
    >;
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
    webSearchMode?: 'disabled' | 'cached' | 'live';
    toolDefinitions: readonly ToolDefinition[];
    instructions: string;
  }): Promise<ModelStepResponse> {
    return createModelStepResponse({
      fetchImpl: this.fetchImpl,
      endpoint: this.endpoint,
      aiProviderBaseUrl: this.aiProviderBaseUrl,
      maxRetries: MAX_TRANSIENT_MODEL_RETRIES,
      ...input,
      debugResponse: (kind, payload) => debugResponseShape(input.sessionId, kind, payload)
    });
  }

  private persistSession(record: ModelSessionRecord): void {
    this.notebook.upsertModelSession(record);
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
