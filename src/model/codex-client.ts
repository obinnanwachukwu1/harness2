import { randomUUID } from 'node:crypto';

import { OPENAI_CODEX_ORIGINATOR, OpenAICodexAuth } from '../auth/openai-codex.js';
import { clampText, estimateTokens, nowIso } from '../lib/utils.js';
import { EXPERIMENT_SUBAGENT_PROMPT, MAIN_AGENT_PROMPT } from './codex-prompt.js';
import { Notebook } from '../storage/notebook.js';
import type {
  AgentTools,
  ExperimentObservationTag,
  ModelHistoryItem,
  ModelSessionRecord,
  TranscriptRole
} from '../types.js';

const DEFAULT_MODEL = process.env.H2_CODEX_MODEL ?? 'gpt-5.4';
const DEFAULT_REASONING_EFFORT = normalizeReasoningEffort(process.env.H2_REASONING_EFFORT) ?? 'medium';
const DEFAULT_ENDPOINT =
  process.env.H2_CODEX_BASE_URL ?? 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_MAX_MODEL_STEPS = 24;
const MAX_MODEL_STEPS = normalizeMaxModelSteps(process.env.H2_MAX_MODEL_STEPS);

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
  content?: Array<{ type?: string; text?: string }>;
}

interface ResponsePayload {
  id?: string;
  output?: ResponseItem[];
  output_text?: string;
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

    for (let step = 0; step < MAX_MODEL_STEPS; step += 1) {
      const response = await this.createResponse({
        accessToken,
        accountId: authRecord.accountId,
        sessionId,
        settings,
        input: requestItems.map(toResponseInputItem),
        onAssistantStream,
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
            result.failed ? `${result.output}\nTool execution failed.` : result.output
          )
        );
      }

      requestItems = this.notebook.buildModelRequestHistory(sessionId);
    }

    await emit(
      'assistant',
      `Stopped after ${MAX_MODEL_STEPS} model/tool steps. Increase H2_MAX_MODEL_STEPS if this turn needs more tool work.`
    );
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
    settings: ModelSessionRecord;
    input: unknown;
    onAssistantStream?: (text: string) => Promise<void>;
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
        store: false,
        stream: true
      };

    if (input.settings.reasoningEffort) {
      body.reasoning = {
        effort: input.settings.reasoningEffort
      };
    }

    const response = await this.fetchImpl(this.endpoint, {
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
      return (await response.json()) as ResponsePayload;
    }

    return readStreamingResponse(response, input.onAssistantStream);
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
      return tools.read(readStringArg(args, 'path'));
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
        budgetTokens: readOptionalNumberArg(args, 'budgetTokens') ?? 1200,
        preserve: readOptionalBooleanArg(args, 'preserve') ?? false
      });
      return JSON.stringify(experiment, null, 2);
    }
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
          readOptionalNumberArg(args, 'timeoutMs')
        ),
        null,
        2
      );
    case 'search_experiments':
      if (!tools.searchExperiments) {
        throw new Error('search_experiments is not available in this session.');
      }
      return JSON.stringify(await tools.searchExperiments(readOptionalStringArg(args, 'query')), null, 2);
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
      if (content.type === 'output_text' && typeof content.text === 'string') {
        pieces.push(content.text);
      }
    }
  }

  return pieces.join('\n').trim();
}

function toResponseInputItem(item: ModelHistoryItem):
  | { role: 'user' | 'assistant' | 'system'; content: string }
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

function formatToolOutput(name: string, output: string): string {
  // TODO: spill oversized tool results to disk and replace them with a short inline pointer.
  return `[${name}]\n${clampText(output, 2400)}`;
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

function normalizeMaxModelSteps(value: string | undefined): number {
  if (!value) {
    return DEFAULT_MAX_MODEL_STEPS;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return DEFAULT_MAX_MODEL_STEPS;
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
  onAssistantStream?: (text: string) => Promise<void>
): Promise<ResponsePayload> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Streaming response did not include a body.');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let completed: ResponsePayload | null = null;
  let liveAssistantText = '';

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

      if (event?.type === 'response.completed' && event.response) {
        completed = event.response as ResponsePayload;
      }

      boundary = buffer.indexOf('\n\n');
    }
  }

  if (!completed) {
    throw new Error('Streaming response ended before response.completed.');
  }

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
  if (contentPart.type !== 'output_text') {
    return '';
  }

  return typeof contentPart.text === 'string' ? contentPart.text : '';
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

export const MAIN_TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'bash',
    description: 'Run a shell command in the current workspace.',
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
    description: 'Read a file from the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' }
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
    description: 'Find files using a glob pattern.',
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
    description: 'Search files for a text pattern.',
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
    description: 'Run a scoped experiment in a separate git worktree.',
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
    name: 'read_experiment',
    description: 'Read the status and observations for a previously spawned experiment.',
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
    description: 'Wait for a running experiment to resolve, up to a bounded timeout in milliseconds.',
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
  MAIN_TOOL_DEFINITIONS[7],
  {
    type: 'function',
    name: 'resolve_experiment',
    description: 'Resolve the current experiment with a verdict and summary.',
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
