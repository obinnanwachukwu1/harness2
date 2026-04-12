import { stepCountIs, streamText, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

import { OPENAI_CODEX_ORIGINATOR } from '../auth/openai-codex.js';
import { formatToolHeader, formatLiveToolBody, buildAiSdkTools, parseArguments, type ToolDefinition } from './model-tooling.js';
import type { ModelHistoryItem, ModelSessionRecord } from '../types.js';

const DEFAULT_WEB_SEARCH_MODE = 'cached';

export interface ModelStepResponse {
  id?: string;
  assistantText: string;
  reasoningSummary: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  toolCalls: Array<{ name: string; callId: string; rawArguments: string }>;
  providerToolEvents: ProviderToolEvent[];
}

export interface ProviderToolEvent {
  name: 'web_search';
  toolCallId: string;
  transcript: string;
  historyNotice: string;
}

export interface ModelProviderFailure {
  kind: 'transient' | 'auth' | 'fatal';
  message: string;
  code?: string;
  status?: number;
}

interface ResponseInputItemMessage {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string;
}

interface ResponseInputFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponseInputFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

type ResponseInputItem =
  | ResponseInputItemMessage
  | ResponseInputFunctionCall
  | ResponseInputFunctionCallOutput;

export async function createModelStepResponse(input: {
  fetchImpl: typeof fetch;
  endpoint: string;
  aiProviderBaseUrl: string;
  maxRetries: number;
  accessToken: string;
  accountId: string;
  sessionId: string;
  settings: ModelSessionRecord;
  input: ResponseInputItem[];
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
  debugResponse?: (kind: string, payload: unknown) => Promise<void>;
}): Promise<ModelStepResponse> {
  const provider = createOpenAI({
    apiKey: input.accessToken,
    baseURL: input.aiProviderBaseUrl,
    fetch: async (requestInput, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${input.accessToken}`);
      headers.set('originator', OPENAI_CODEX_ORIGINATOR);
      headers.set('session_id', input.sessionId);

      if (input.accountId) {
        headers.set('chatgpt-account-id', input.accountId);
      }

      const parsed =
        requestInput instanceof URL
          ? requestInput
          : new URL(typeof requestInput === 'string' ? requestInput : requestInput.url);
      const url =
        parsed.pathname.includes('/v1/responses') || parsed.pathname.includes('/chat/completions')
          ? new URL(input.endpoint)
          : parsed;

      return fetchWithRetries(input.fetchImpl, url, { ...init, headers }, input.maxRetries);
    }
  });
  const model = provider.responses(input.settings.model);
  const messages = buildAiSdkMessages(input.input);
  const tools = buildAiSdkTools(
    input.toolDefinitions,
    provider,
    getWebSearchMode(input.webSearchMode)
  );
  let liveAssistantText = '';
  let liveReasoningSummary = '';

  await input.debugResponse?.('request', {
    endpoint: input.endpoint,
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
    maxRetries: input.maxRetries,
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
  const usage = normalizeModelUsage(await result.usage);

  await input.debugResponse?.('sdk_response', {
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
    usage
  });

  return {
    id: response.id ?? undefined,
    assistantText: assistantText.trim() || liveAssistantText.trim(),
    reasoningSummary: reasoningSummary?.trim() || liveReasoningSummary.trim(),
    usage,
    toolCalls: localToolCalls.map((call) => ({
      name: call.toolName,
      callId: call.toolCallId,
      rawArguments: JSON.stringify(call.input)
    })),
    providerToolEvents
  };
}

function normalizeModelUsage(input: unknown): {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
} {
  if (!input || typeof input !== 'object') {
    return {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0
    };
  }

  const value = input as {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
  const inputTokens = value.inputTokens ?? 0;
  const cachedInputTokens = value.cachedInputTokens ?? 0;
  const outputTokens = value.outputTokens ?? 0;
  const reasoningTokens = value.reasoningTokens ?? 0;
  const totalTokens = value.totalTokens ?? inputTokens + outputTokens;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens
  };
}

export function toResponseInputItem(item: ModelHistoryItem): ResponseInputItem {
  if (item.type === 'message') {
    return {
      role: item.role,
      content: item.content
    };
  }

  return item;
}

function buildAiSdkMessages(items: ResponseInputItem[]): ModelMessage[] {
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

function getWebSearchMode(
  override?: 'disabled' | 'cached' | 'live'
): 'disabled' | 'cached' | 'live' {
  if (override) {
    return override;
  }
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

  return value as {
    action?: { type?: string; query?: string };
    sources?: Array<{ type: string; url?: string; name?: string }>;
  };
}

function compactTextForHeader(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

async function fetchWithRetries(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  maxRetries: number
): Promise<Response> {
  let attempt = 0;
  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  while (attempt <= maxRetries) {
    try {
      const response = await fetchImpl(input, init);
      if (!isRetryableResponse(response)) {
        return response;
      }

      lastResponse = response;
      if (attempt === maxRetries) {
        return response;
      }

      attempt += 1;
      await delay(resolveRetryDelayMs(response, attempt));
      continue;
    } catch (error) {
      lastError = error;
      if (!isRetryableTransportError(error) || attempt === maxRetries) {
        throw error;
      }

      attempt += 1;
      await delay(resolveRetryDelayMs(undefined, attempt));
    }
  }

  if (lastError) {
    throw lastError;
  }
  return lastResponse ?? fetchImpl(input, init);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableResponse(response: Response): boolean {
  return [408, 429, 500, 502, 503, 504].includes(response.status);
}

function resolveRetryDelayMs(response: Response | undefined, attempt: number): number {
  const retryAfterMs = response ? parseRetryAfterMs(response) : null;
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }
  return Math.min(5_000, 250 * 2 ** Math.max(0, attempt - 1));
}

function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after')?.trim();
  if (!header) {
    return null;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(30_000, Math.round(seconds * 1000));
  }

  const retryAt = Date.parse(header);
  if (Number.isNaN(retryAt)) {
    return null;
  }

  return Math.min(30_000, Math.max(0, retryAt - Date.now()));
}

function isRetryableTransportError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  const code = errorCode(error)?.toUpperCase();

  return (
    code === 'EAI_AGAIN' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNABORTED' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    message.includes('eai_again') ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('connect timeout') ||
    message.includes('connection reset') ||
    message.includes('socket hang up') ||
    message.includes('fetch failed') ||
    message.includes('network error') ||
    message.includes('temporarily unavailable') ||
    message.includes('enotfound')
  );
}

export function classifyModelProviderFailure(error: unknown): ModelProviderFailure {
  const message = errorMessage(error);
  const messageLower = message.toLowerCase();
  const code = errorCode(error);
  const status = errorStatus(error);

  if (
    status === 401 ||
    status === 403 ||
    messageLower.includes('unauthorized') ||
    messageLower.includes('forbidden') ||
    messageLower.includes('authentication') ||
    messageLower.includes('invalid api key') ||
    messageLower.includes('incorrect api key')
  ) {
    return {
      kind: 'auth',
      message,
      code: code ?? undefined,
      status: status ?? undefined
    };
  }

  if ((status !== null && isRetryableStatus(status)) || isRetryableTransportError(error)) {
    return {
      kind: 'transient',
      message,
      code: code ?? undefined,
      status: status ?? undefined
    };
  }

  return {
    kind: 'fatal',
    message,
    code: code ?? undefined,
    status: status ?? undefined
  };
}

function isRetryableStatus(status: number): boolean {
  return [408, 429, 500, 502, 503, 504].includes(status);
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const value = Reflect.get(error, 'code');
  return typeof value === 'string' ? value : null;
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const direct = Reflect.get(error, 'status');
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct;
  }
  const response = Reflect.get(error, 'response');
  if (response && typeof response === 'object') {
    const nested = Reflect.get(response, 'status');
    if (typeof nested === 'number' && Number.isFinite(nested)) {
      return nested;
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
