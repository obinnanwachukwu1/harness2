import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execa } from 'execa';

import {
  OPENAI_CODEX_PROVIDER,
  OPENAI_CODEX_RESPONSES_ENDPOINT,
  OpenAICodexAuth
} from '../auth/openai-codex.js';
import { clampText, estimateTokens, nowIso } from '../lib/utils.js';
import {
  DIRECT_AGENT_PROMPT,
  EXPERIMENT_SUBAGENT_PROMPT,
  PLAN_AGENT_PROMPT,
  STUDY_AGENT_PROMPT
} from './model-prompt.js';
import { Notebook } from '../storage/notebook.js';
import {
  buildObservationHint,
  shouldInjectObservationHint,
} from './model-hints.js';
import {
  executeToolCallBatch,
  DIRECT_TOOL_DEFINITIONS,
  formatLiveToolBody,
  formatToolHeader,
  formatToolOutput,
  isParallelReadOnlyToolCall,
  MAIN_TOOL_DEFINITIONS,
  PLAN_EXECUTION_TOOL_DEFINITIONS,
  PLAN_PLANNING_TOOL_DEFINITIONS,
  STUDY_TOOL_DEFINITIONS,
  type ToolDefinition
} from './model-tooling.js';
import {
  classifyModelProviderFailure,
  createModelStepResponse,
  type ModelStepResponse,
  type ProviderToolEvent,
  toResponseInputItem
} from './model-response.js';
import {
  ensureModelsDevCatalog,
  getModelsDevResolvedMetadata,
  type ModelsDevResolvedMetadata
} from './models-dev.js';
import {
  renderPlanDirectCheckpointBlock,
  runPlanDirectCompactor,
  writePlanDirectCompactionArtifacts
} from './plan-direct-compactor.js';
import type {
  AgentTools,
  CompactionArtifactPointer,
  HiddenCompactionStateSnapshot,
  ModelSessionRecord,
  ModelHistoryItem,
  TranscriptRole
} from '../types.js';

const DEFAULT_MODEL = process.env.H2_MODEL ?? 'gpt-5.4';
const DEFAULT_REASONING_EFFORT = normalizeReasoningEffort(process.env.H2_REASONING_EFFORT) ?? 'medium';
const DEFAULT_ENDPOINT = process.env.H2_MODEL_BASE_URL ?? OPENAI_CODEX_RESPONSES_ENDPOINT;
const MAX_TRANSIENT_MODEL_RETRIES = 2;
const DEBUG_RESPONSES_ENABLED = process.env.H2_DEBUG_RESPONSES === '1';
const DEBUG_RESPONSES_FILE =
  process.env.H2_DEBUG_RESPONSES_FILE ??
  path.join(process.cwd(), '.h2', 'debug', 'responses.jsonl');
const COMPACTION_ADVISORY_RATIO = 0.75;
const COMPACTION_WARNING_RATIO = 0.85;
const COMPACTION_RESERVED_TOKEN_FLOOR = 10_000;
const COMPACTION_RESERVED_TOKEN_RATIO = 0.08;
const TOOL_OUTPUT_SPILL_THRESHOLD_TOKENS = 5_000;
const TOOL_OUTPUT_PREVIEW_CHAR_LIMIT = 1_600;
const PLAN_DIRECT_RAW_TAIL_TOKEN_CAP = 10_000;
const PLAN_DIRECT_RAW_TAIL_WINDOW_RATIO = 0.10;
const SPILLABLE_TOOL_OUTPUT_NAMES = new Set([
  'exec_command',
  'write_stdin',
  'ls',
  'glob',
  'rg',
  'grep',
  'web_search',
  'read_experiment',
  'wait_experiment',
  'search_experiments'
]);

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

export {
  DIRECT_TOOL_DEFINITIONS,
  EXPERIMENT_TOOL_DEFINITIONS,
  MAIN_TOOL_DEFINITIONS,
  PLAN_EXECUTION_TOOL_DEFINITIONS,
  PLAN_PLANNING_TOOL_DEFINITIONS,
  STUDY_TOOL_DEFINITIONS
} from './model-tooling.js';

export function resolveSessionPromptAndTools(settings: ModelSessionRecord): {
  instructions: string;
  toolDefinitions: readonly ToolDefinition[];
} {
  if (settings.agentMode === 'direct') {
    return {
      instructions: DIRECT_AGENT_PROMPT,
      toolDefinitions: DIRECT_TOOL_DEFINITIONS
    };
  }

  if (settings.agentMode === 'plan') {
    if (settings.planModePhase === 'execution') {
      return {
        instructions: PLAN_AGENT_PROMPT,
        toolDefinitions: PLAN_EXECUTION_TOOL_DEFINITIONS
      };
    }

    return {
      instructions: PLAN_AGENT_PROMPT,
      toolDefinitions: PLAN_PLANNING_TOOL_DEFINITIONS
    };
  }

  return {
    instructions: STUDY_AGENT_PROMPT,
    toolDefinitions: STUDY_TOOL_DEFINITIONS
  };
}

interface ModelClientOptions {
  fetchImpl?: typeof fetch;
  endpoint?: string;
  model?: string;
}

interface ContextWindowUsage {
  usedTokens: number;
  effectiveBudgetTokens: number;
  fullContextTokens: number;
  inputLimitTokens: number | null;
  standardRateTokens: number | null;
  allowOverStandardContext: boolean;
}

interface CompactionWindowState extends ContextWindowUsage {
  remainingTokens: number;
  reservedTokens: number;
  usageRatio: number;
  shouldSuggestCompact: boolean;
  shouldWarnCompact: boolean;
  forceCompactOnly: boolean;
}

interface ResolvedContextPolicy {
  fullContextTokens: number;
  inputLimitTokens: number | null;
  outputLimitTokens: number | null;
  standardRateTokens: number | null;
  effectiveBudgetTokens: number;
  allowOverStandardContext: boolean;
}

interface RunTurnInput {
  sessionId: string;
  inputText: string;
  tools: AgentTools;
  emit: (role: TranscriptRole, text: string) => Promise<void>;
  onAssistantStream?: (text: string) => Promise<void>;
  onReasoningSummaryStream?: (text: string) => Promise<void>;
  thinkingEnabled?: boolean;
  abortSignal?: AbortSignal;
  webSearchMode?: 'disabled' | 'cached' | 'live';
  toolDefinitions?: readonly ToolDefinition[];
  instructions?: string;
  onToolCallStart?: (toolCall: {
    toolCallId: string;
    toolName: string;
    label: string;
    detail?: string | null;
    body?: string[];
    providerExecuted?: boolean;
  }) => Promise<void>;
  onToolCallFinish?: (toolCallId: string, transcriptText?: string) => Promise<void>;
  allowHiddenAutoCompaction?: boolean;
  getHiddenCompactionState?: (() => Promise<HiddenCompactionStateSnapshot>) | undefined;
  consumeQueuedUserMessages?: (() => Promise<string[]>) | undefined;
}

export class ModelClient {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly defaultModel: string;
  private readonly aiProviderBaseUrl: string;

  constructor(
    private readonly notebook: Notebook,
    private readonly auth: OpenAICodexAuth,
    options: ModelClientOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.defaultModel = options.model ?? DEFAULT_MODEL;
    this.aiProviderBaseUrl = 'https://api.openai.com/v1';
    void ensureModelsDevCatalog(this.fetchImpl).catch(() => undefined);
  }

  async runTurn(input: RunTurnInput): Promise<void> {
    const {
      sessionId,
      inputText,
      tools,
      emit,
      onAssistantStream,
      onReasoningSummaryStream,
      thinkingEnabled = false,
      abortSignal,
      webSearchMode = undefined,
      toolDefinitions = STUDY_TOOL_DEFINITIONS,
      instructions = STUDY_AGENT_PROMPT,
      onToolCallStart,
      onToolCallFinish,
      allowHiddenAutoCompaction = false,
      getHiddenCompactionState,
      consumeQueuedUserMessages
    } = input;

    const accessToken = await this.auth.access();
    const authRecord = this.auth.getStored();

    if (!accessToken || !authRecord) {
      await emit(
        'assistant',
        'Model authentication is not configured. Run `/auth login` or `h2 auth login` first.'
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

    turnLoop: for (;;) {
      const emittedProviderToolEventIds = new Set<string>();
      if (allowHiddenAutoCompaction) {
        const compacted = await this.maybeAutoCompactHiddenSession({
          accessToken,
          accountId: authRecord.accountId,
          sessionId,
          settings,
          instructions,
          toolDefinitions,
          getHiddenCompactionState
        });
        if (compacted) {
          requestItems = this.notebook.buildModelRequestHistory(sessionId);
        }
      }

      const compactionState = this.getCompactionWindowState(
        sessionId,
        instructions,
        toolDefinitions
      );
      const effectiveToolDefinitions =
        compactionState.forceCompactOnly &&
        toolDefinitions.some((tool) => tool.name === 'compact')
          ? toolDefinitions.filter((tool) => tool.name === 'compact')
          : toolDefinitions;
      const hints = [
        shouldInjectObservationHint(requestItems, effectiveToolDefinitions)
          ? buildObservationHint()
          : null,
        buildCompactionHint(compactionState, effectiveToolDefinitions)
      ].filter((value): value is string => Boolean(value));
      let response: ModelStepResponse;
      try {
        response = await this.createResponse({
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
          abortSignal,
          webSearchMode,
          toolDefinitions: effectiveToolDefinitions,
          instructions,
          onToolCallStart,
          onProviderToolEvent: async (event) => {
            emittedProviderToolEventIds.add(event.toolCallId);
            this.persistHistoryItem(sessionId, {
              type: 'message',
              role: 'developer',
              content: event.historyNotice
            });
            await emit('tool', event.transcript);
            await onToolCallFinish?.(event.toolCallId, event.transcript);
          }
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }

        const failure = classifyModelProviderFailure(error);
        const marker = `@@provider_error\tkind=${failure.kind}${
          failure.status ? `\tstatus=${failure.status}` : ''
        }${failure.code ? `\tcode=${failure.code}` : ''}\tmessage=${failure.message}`;
        const assistantMessage =
          failure.kind === 'auth'
            ? `Model authentication failed: ${failure.message}`
            : failure.kind === 'transient'
              ? `Model provider request failed after retries: ${failure.message}`
              : `Model provider error: ${failure.message}`;

        this.persistHistoryItem(sessionId, {
          type: 'message',
          role: 'developer',
          content: marker
        });
        this.persistHistoryItem(sessionId, {
          type: 'message',
          role: 'assistant',
          content: assistantMessage
        });
        await emit('system', marker);
        await emit('assistant', assistantMessage);
        return;
      }

      previousResponseId = response.id ?? previousResponseId;
      const latestSettings = this.getSessionSettings(sessionId);
      this.persistSession({
        sessionId,
        provider: OPENAI_CODEX_PROVIDER,
        model: latestSettings.model,
        reasoningEffort: latestSettings.reasoningEffort,
        allowOverStandardContext: latestSettings.allowOverStandardContext,
        previousResponseId,
        updatedAt: nowIso(),
        agentMode: latestSettings.agentMode,
        planModePhase: latestSettings.planModePhase
      });
      this.notebook.appendModelUsage({
        sessionId,
        responseId: response.id ?? null,
        inputTokens: response.usage.inputTokens,
        cachedInputTokens: response.usage.cachedInputTokens,
        outputTokens: response.usage.outputTokens,
        reasoningTokens: response.usage.reasoningTokens,
        totalTokens: response.usage.totalTokens
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
        if (emittedProviderToolEventIds.has(event.toolCallId)) {
          continue;
        }
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

      const queuedAfterResponse = await consumeQueuedUserMessages?.();
      if (queuedAfterResponse && queuedAfterResponse.length > 0) {
        for (const message of queuedAfterResponse) {
          this.persistHistoryItem(sessionId, {
            type: 'message',
            role: 'user',
            content: message
          });
          await emit('user', message);
        }
        requestItems = this.notebook.buildModelRequestHistory(sessionId);
        continue turnLoop;
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

        const preflightCompactionState = this.getCompactionWindowState(
          sessionId,
          instructions,
          toolDefinitions
        );
        if (
          preflightCompactionState.forceCompactOnly &&
          batchCalls.some((call) => call.name !== 'compact') &&
          toolDefinitions.some((tool) => tool.name === 'compact')
        ) {
          const guardrail = buildForcedCompactionGuardrail(preflightCompactionState);
          this.persistHistoryItem(sessionId, {
            type: 'message',
            role: 'developer',
            content: guardrail
          });
          await emit('system', guardrail);
          requestItems = this.notebook.buildModelRequestHistory(sessionId);
          continue turnLoop;
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
          const compactedOutput = await this.materializeToolOutput(
            sessionId,
            call.name,
            call.callId,
            result.output
          );
          const functionCallItem: ModelHistoryItem = {
            type: 'function_call',
            call_id: call.callId,
            name: call.name,
            arguments: call.rawArguments
          };
          const functionCallOutputItem: ModelHistoryItem = {
            type: 'function_call_output',
            call_id: call.callId,
            output: compactedOutput
          };

          this.persistHistoryItem(sessionId, functionCallItem);
          this.persistHistoryItem(sessionId, functionCallOutputItem);
          const transcriptText = formatToolOutput(
            call.name,
            call.rawArguments,
            result.failed ? `${compactedOutput}\nTool execution failed.` : compactedOutput
          );
          await emit('tool', transcriptText);
          await onToolCallFinish?.(call.callId, transcriptText);
        }

        if (batchCalls.some((call) => call.name === 'ask_user')) {
          return;
        }

        const queuedAfterToolBatch = await consumeQueuedUserMessages?.();
        if (queuedAfterToolBatch && queuedAfterToolBatch.length > 0) {
          for (const message of queuedAfterToolBatch) {
            this.persistHistoryItem(sessionId, {
              type: 'message',
              role: 'user',
              content: message
            });
            await emit('user', message);
          }
          requestItems = this.notebook.buildModelRequestHistory(sessionId);
          continue turnLoop;
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
    const modeConfig = resolveSessionPromptAndTools(settings);
    const {
      usedTokens,
      effectiveBudgetTokens,
      fullContextTokens,
      inputLimitTokens,
      standardRateTokens,
      allowOverStandardContext
    } = this.getCompactionWindowState(
      sessionId,
      modeConfig.instructions,
      modeConfig.toolDefinitions
    );
    return {
      usedTokens,
      effectiveBudgetTokens,
      fullContextTokens,
      inputLimitTokens,
      standardRateTokens,
      allowOverStandardContext
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
    abortSignal?: AbortSignal;
    webSearchMode?: 'disabled' | 'cached' | 'live';
    toolDefinitions: readonly ToolDefinition[];
    instructions: string;
  }): Promise<ModelStepResponse> {
    void ensureModelsDevCatalog(this.fetchImpl).catch(() => undefined);
    return createModelStepResponse({
      fetchImpl: this.fetchImpl,
      endpoint: this.endpoint,
      aiProviderBaseUrl: this.aiProviderBaseUrl,
      maxRetries: MAX_TRANSIENT_MODEL_RETRIES,
      ...input,
      debugResponse: (kind, payload) => debugResponseShape(input.sessionId, kind, payload)
    });
  }

  private async maybeAutoCompactHiddenSession(input: {
    accessToken: string;
    accountId: string;
    sessionId: string;
    settings: ModelSessionRecord;
    instructions: string;
    toolDefinitions: readonly ToolDefinition[];
    getHiddenCompactionState?: (() => Promise<HiddenCompactionStateSnapshot>) | undefined;
  }): Promise<boolean> {
    const compactionState = this.getCompactionWindowState(
      input.sessionId,
      input.instructions,
      input.toolDefinitions
    );
    if (!compactionState.forceCompactOnly) {
      return false;
    }

    const session = this.notebook.getSession(input.sessionId);
    if (!session) {
      return false;
    }

    const tailTokenBudget = Math.max(
      1,
      Math.min(
        PLAN_DIRECT_RAW_TAIL_TOKEN_CAP,
        Math.floor(compactionState.effectiveBudgetTokens * PLAN_DIRECT_RAW_TAIL_WINDOW_RATIO)
      )
    );
    const nextTailStartHistoryId = this.notebook.getTailStartHistoryIdByTokenBudget(
      input.sessionId,
      tailTokenBudget
    );
    const latestCheckpoint = this.notebook.getLatestSessionCheckpoint(input.sessionId);
    const transcriptStartId =
      latestCheckpoint?.tailStartHistoryId ?? null;
    const transcriptMiddle = this.notebook.listModelHistoryRange(input.sessionId, {
      startIdInclusive: transcriptStartId,
      endIdExclusive: nextTailStartHistoryId
    });

    if (transcriptMiddle.length === 0) {
      return false;
    }

    const [gitLog, gitStatus, gitDiffStat, structuredState] = await Promise.all([
      this.readGitSnapshot(session.cwd, ['log', '--oneline', '-5']),
      this.readGitSnapshot(session.cwd, ['status', '--short']),
      this.readGitSnapshot(session.cwd, ['diff', '--stat']),
      this.resolveHiddenCompactionState(input.sessionId, input.settings, input.getHiddenCompactionState)
    ]);
    const artifactPointers = this.buildCompactionArtifactPointers(
      session.cwd,
      structuredState.approvedPlan
    );

    const summary = await runPlanDirectCompactor({
      fetchImpl: this.fetchImpl,
      endpoint: this.endpoint,
      accessToken: input.accessToken,
      accountId: input.accountId,
      sessionId: `compact-${input.sessionId}-${Date.now()}`,
      input: {
        mode: structuredState.mode,
        previousCheckpoint: latestCheckpoint?.checkpointSummary ?? null,
        structuredState,
        transcriptMiddle,
        gitLog,
        gitStatus,
        gitDiffStat,
        artifactPointers,
        originalUserRequest: this.getOriginalUserPrompt(input.sessionId)
      }
    });

    const compactionArtifacts = await writePlanDirectCompactionArtifacts({
      cwd: session.cwd,
      transcriptMiddle,
      summary,
      artifactPointers
    });
    const checkpointBlock = renderPlanDirectCheckpointBlock({
      summary,
      structuredState,
      gitLog,
      gitStatus,
      gitDiffStat,
      compactionArtifacts
    });

    this.notebook.createSessionCheckpoint({
      sessionId: input.sessionId,
      checkpointKind:
        structuredState.mode === 'experiment' ? 'experiment_subagent' : 'plan_direct',
      goal: summary.task.goal,
      completed: summary.state.completed.join(' | ') || '(none)',
      next: summary.state.next.join(' | ') || '(none)',
      openRisks: summary.state.blockers.join(' | ') || undefined,
      currentCommitments:
        summary.durable_decisions.map((decision) => decision.decision).join(' | ') || undefined,
      importantNonGoals: summary.task.non_goals.join(' | ') || undefined,
      gitLog,
      gitStatus,
      gitDiffStat,
      lastTestStatus: structuredState.lastTestStatus,
      activeExperimentSummaries: [],
      invalidatedExperimentSummaries: [],
      checkpointBlock,
      checkpointSummary: summary,
      artifacts: compactionArtifacts.pointers,
      tailStartHistoryId: nextTailStartHistoryId
    });

    return true;
  }

  private async readGitSnapshot(cwd: string, args: string[]): Promise<string> {
    const result = await execa('git', args, {
      cwd,
      reject: false
    });

    if (result.exitCode === 0) {
      return result.stdout.trim() || '(clean)';
    }

    const errorText = result.stderr.trim() || result.stdout.trim() || '(unavailable)';
    return `git ${args.join(' ')} failed: ${clampText(errorText, 500)}`;
  }

  private buildCompactionArtifactPointers(
    cwd: string,
    approvedPlan: HiddenCompactionStateSnapshot['approvedPlan']
  ): CompactionArtifactPointer[] {
    const pointers: CompactionArtifactPointer[] = [];
    if (approvedPlan?.planPath) {
      pointers.push({
        path: approvedPlan.planPath,
        why: 'approved plan artifact'
      });
    }

    const toolOutputDir = path.join(cwd, '.h2', 'tool-output');
    pointers.push({
      path: toolOutputDir,
      why: 'spilled large tool outputs'
    });
    return pointers;
  }

  private getOriginalUserPrompt(sessionId: string): string {
    const history = this.notebook.listModelHistory(sessionId);
    const firstUserMessage = history.find(
      (item) => item.type === 'message' && item.role === 'user'
    );
    return firstUserMessage?.type === 'message' ? firstUserMessage.content : '';
  }

  private async resolveHiddenCompactionState(
    sessionId: string,
    settings: ModelSessionRecord,
    getHiddenCompactionState?: (() => Promise<HiddenCompactionStateSnapshot>) | undefined
  ): Promise<HiddenCompactionStateSnapshot> {
    if (getHiddenCompactionState) {
      return getHiddenCompactionState();
    }

    return {
      mode: settings.agentMode === 'plan' ? 'plan' : 'direct',
      planModePhase: settings.planModePhase,
      approvedPlan: this.notebook.getSessionPlan(sessionId),
      todos: this.notebook.listSessionTodos(sessionId),
      lastTestStatus: this.notebook.getLatestSessionCheckpoint(sessionId)?.lastTestStatus ?? null,
      activeProcessSummary: [],
      experimentState: null
    };
  }

  private persistSession(record: ModelSessionRecord): void {
    this.notebook.upsertModelSession(record);
  }

  private persistHistoryItem(sessionId: string, item: ModelHistoryItem): void {
    this.notebook.appendModelHistoryItem(sessionId, item);
  }

  private getCompactionWindowState(
    sessionId: string,
    instructions: string,
    toolDefinitions: readonly ToolDefinition[]
  ): CompactionWindowState {
    const settings = this.getSessionSettings(sessionId);
    const historyItems = this.notebook.buildModelRequestHistory(sessionId);
    const usedTokens =
      estimateTokens(instructions) +
      estimateTokens(JSON.stringify(toolDefinitions)) +
      historyItems.reduce((total, item) => total + estimateHistoryItemTokens(item), 0);
    const contextPolicy = resolveContextPolicy(settings);
    const totalTokens = contextPolicy.effectiveBudgetTokens;
    const standardRateTokens = contextPolicy.standardRateTokens;
    const reservedTokens = Math.max(
      1,
      Math.min(
        Math.max(1, totalTokens - 1),
        Math.max(
          COMPACTION_RESERVED_TOKEN_FLOOR,
          Math.ceil(totalTokens * COMPACTION_RESERVED_TOKEN_RATIO)
        )
      )
    );
    const remainingTokens = Math.max(0, totalTokens - usedTokens);
    const usageRatio = totalTokens > 0 ? usedTokens / totalTokens : 1;

    return {
      usedTokens,
      effectiveBudgetTokens: totalTokens,
      fullContextTokens: contextPolicy.fullContextTokens,
      inputLimitTokens: contextPolicy.inputLimitTokens,
      standardRateTokens,
      allowOverStandardContext: contextPolicy.allowOverStandardContext,
      remainingTokens,
      reservedTokens,
      usageRatio,
      shouldSuggestCompact: usageRatio >= COMPACTION_ADVISORY_RATIO,
      shouldWarnCompact: usageRatio >= COMPACTION_WARNING_RATIO,
      forceCompactOnly: remainingTokens <= reservedTokens
    };
  }

  private async materializeToolOutput(
    sessionId: string,
    toolName: string,
    toolCallId: string,
    output: string
  ): Promise<string> {
    if (
      output.startsWith('@@tool\t') ||
      !SPILLABLE_TOOL_OUTPUT_NAMES.has(toolName) ||
      estimateTokens(output) < TOOL_OUTPUT_SPILL_THRESHOLD_TOKENS
    ) {
      return output;
    }

    const session = this.notebook.getSession(sessionId);
    if (!session) {
      return output;
    }

    const spillDir = path.join(session.cwd, '.h2', 'tool-output', sessionId);
    const spillFileName = `${Date.now()}-${sanitizeFileComponent(toolCallId)}-${sanitizeFileComponent(toolName)}.txt`;
    const spillPath = path.join(spillDir, spillFileName);
    await mkdir(spillDir, { recursive: true });
    await writeFile(spillPath, output, 'utf8');

    const relativePath = path.relative(session.cwd, spillPath) || spillFileName;
    return [
      `Large ${toolName} output spilled to ${relativePath} (${output.length} chars, ~${estimateTokens(output)} tokens).`,
      'Use read on that file if the full output is still needed.',
      '',
      'Preview:',
      clampText(output, TOOL_OUTPUT_PREVIEW_CHAR_LIMIT)
    ].join('\n');
  }

  private getSessionSettings(sessionId: string): ModelSessionRecord {
    const existing = this.notebook.getModelSession(sessionId);
    if (existing) {
      return {
        ...existing,
        reasoningEffort: existing.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
        allowOverStandardContext: existing.allowOverStandardContext ?? false
      };
    }

    return {
      sessionId,
      provider: OPENAI_CODEX_PROVIDER,
      model: this.defaultModel,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      allowOverStandardContext: false,
      previousResponseId: null,
      updatedAt: nowIso(),
      agentMode: 'study',
      planModePhase: null
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

function buildCompactionHint(
  state: CompactionWindowState,
  toolDefinitions: readonly ToolDefinition[]
): string | null {
  if (!toolDefinitions.some((tool) => tool.name === 'compact')) {
    return null;
  }

  if (state.forceCompactOnly) {
    return buildForcedCompactionGuardrail(state);
  }

  if (state.shouldWarnCompact) {
    return [
      `Context is tight (${formatCompactionUsage(state)}).`,
      'Compact soon so the session can checkpoint state before the reserve buffer is exhausted.'
    ].join(' ');
  }

  if (state.shouldSuggestCompact) {
    return [
      `Context is getting tight (${formatCompactionUsage(state)}).`,
      'Compact is available once you have a clean checkpoint boundary.'
    ].join(' ');
  }

  return null;
}

function buildForcedCompactionGuardrail(state: CompactionWindowState): string {
  return [
    `Context reserve is exhausted (${formatCompactionUsage(state)}; reserve ${state.reservedTokens} tokens).`,
    'Only compact is available until the session checkpoints and trims replay.'
  ].join(' ');
}

function formatCompactionUsage(state: CompactionWindowState): string {
  return `${state.usedTokens}/${state.effectiveBudgetTokens} estimated tokens`;
}

function sanitizeFileComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function resolveContextPolicy(settings: ModelSessionRecord): ResolvedContextPolicy {
  const allowOverStandardContext =
    settings.allowOverStandardContext || isEnvEnabled(process.env.ALLOW_OVER_STANDARD_CONTEXT);
  const metadata = getModelsDevResolvedMetadata(settings.model);
  const fullContextTokens = metadata?.contextTokens ?? getModelContextWindow(settings.model);
  const inputLimitTokens = metadata?.inputTokens ?? getModelInputLimit(settings.model);
  const outputLimitTokens = metadata?.outputTokens ?? null;
  const standardRateTokens = getModelStandardRateThreshold(settings.model, metadata);
  const hardBudget = inputLimitTokens !== null ? Math.min(inputLimitTokens, fullContextTokens) : fullContextTokens;
  const effectiveBudgetTokens =
    !allowOverStandardContext && standardRateTokens !== null
      ? Math.min(hardBudget, standardRateTokens)
      : hardBudget;

  return {
    fullContextTokens,
    inputLimitTokens,
    outputLimitTokens,
    standardRateTokens,
    effectiveBudgetTokens,
    allowOverStandardContext
  };
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

  return 272_000;
}

function getModelInputLimit(model: string): number | null {
  const normalized = model.trim().toLowerCase();

  if (normalized === 'gpt-5.4-mini') {
    return 400_000;
  }

  return null;
}

function getModelStandardRateThreshold(
  model: string,
  metadata: ModelsDevResolvedMetadata | null = null
): number | null {
  if (metadata?.hasOver200kPricing) {
    return 200_000;
  }

  const normalized = model.trim().toLowerCase();

  if (normalized === 'gpt-5.4' || normalized === 'gpt-5.4-pro') {
    return 200_000;
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

function isEnvEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
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
