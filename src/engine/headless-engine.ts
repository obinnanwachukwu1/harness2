import { access, glob, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { execa, execaCommand } from 'execa';

import { OpenAICodexAuth } from '../auth/openai-codex.js';
import { migrateLegacyRepoLocalAuth, openGlobalAuthNotebook } from '../auth/storage.js';
import { ExperimentManager } from '../experiments/experiment-manager.js';
import { clampText, createSessionId, formatUnknownError, lines, nowIso } from '../lib/utils.js';
import {
  ModelClient,
  EXPERIMENT_TOOL_DEFINITIONS,
  resolveSessionPromptAndTools
} from '../model/model-client.js';
import { EXPERIMENT_SUBAGENT_PROMPT } from '../model/model-prompt.js';
import { Notebook } from '../storage/notebook.js';
import type {
  AgentMode,
  AgentRunner,
  AgentTools,
  AskUserInput,
  AskUserResult,
  ApprovePlanResult,
  CreatePlanInput,
  CreatePlanResult,
  EngineSnapshot,
  ExperimentAdoptionPreview,
  ExperimentAdoptionResult,
  ExperimentBudgetNotification,
  ExperimentDetails,
  ExperimentObservationTag,
  ExperimentQualityNotification,
  ExecCommandInput,
  ExecCommandResult,
  ExperimentRecord,
  ExperimentResolution,
  ExperimentSearchGuardrail,
  ExperimentSearchResult,
  ExperimentWaitResult,
  HiddenCompactionStateSnapshot,
  LiveTurnEvent,
  ModelHistoryItem,
  ModelSessionRecord,
  PlanStatusResult,
  SessionExportResult,
  SpawnExperimentInput,
  StudyDebtKind,
  StudyDebtRecord,
  StudyDebtResolution,
  TranscriptRole,
  UpdateTodosInput,
  UpdateTodosResult,
  WriteStdinInput,
  WriteStdinResult
} from '../types.js';
import { executeEditPatch } from './edit-patch.js';
import { PrototypeRunner } from './prototype-runner.js';

interface OpenEngineOptions {
  cwd: string;
  sessionId?: string;
  revealExportsInFinder?: boolean;
  webSearchMode?: 'disabled' | 'cached' | 'live';
  agentMode?: AgentMode;
  forceStudyCompactionOnce?: boolean;
}

const DEFAULT_EXPERIMENT_MODEL = process.env.H2_EXPERIMENT_MODEL ?? 'gpt-5.4-mini';
const DEFAULT_EXPERIMENT_REASONING_EFFORT =
  (process.env.H2_EXPERIMENT_REASONING_EFFORT as 'low' | 'medium' | 'high' | 'off' | undefined) ??
  'high';
const DEFAULT_COMMAND_SHELL =
  process.env.H2_COMMAND_SHELL ?? process.env.SHELL ?? (process.platform === 'darwin' ? 'zsh' : 'bash');
const DEFAULT_EXEC_YIELD_MS = 1_000;
const DEFAULT_EXEC_MAX_OUTPUT_CHARS = 12_000;
const MAX_EXEC_PENDING_OUTPUT_CHARS = 200_000;
const MAX_EXEC_CAPTURED_OUTPUT_CHARS = 64_000;

interface ExecSession {
  id: number;
  command: string;
  cwd: string;
  root: string;
  probeQuestionIds: string[];
  child: ChildProcessWithoutNullStreams;
  pendingStdout: string;
  pendingStderr: string;
  droppedStdoutChars: number;
  droppedStderrChars: number;
  capturedStdout: string;
  capturedStderr: string;
  exitCode: number | null;
  running: boolean;
  stdinOpen: boolean;
  updateLastTestStatus: boolean;
  waitForExit: Promise<void>;
  resolveWaitForExit: () => void;
  outputWaiters: Array<() => void>;
}

export class HeadlessEngine {
  private static readonly activeEngines = new Set<HeadlessEngine>();
  private static shutdownHooksInstalled = false;
  private static exitCleanupRan = false;

  static async open(options: OpenEngineOptions): Promise<HeadlessEngine> {
    const sessionId = options.sessionId ?? createSessionId();
    const stateDir = path.join(options.cwd, '.h2');
    const experimentStateDir = path.join(stateDir, 'worktrees');
    await migrateLegacyExperimentState(options.cwd, experimentStateDir);
    const dbPath = path.join(stateDir, 'notebook.sqlite');
    const notebook = new Notebook(dbPath);
    const authNotebook = openGlobalAuthNotebook();
    migrateLegacyRepoLocalAuth(notebook, authNotebook);

    if (options.sessionId) {
      const existing = notebook.getSession(sessionId);
      if (!existing) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      const settings = notebook.getOrCreateModelSession(sessionId, {
        agentMode: options.agentMode
      });
      if (options.agentMode && settings.agentMode !== options.agentMode) {
        throw new Error(
          `Session ${sessionId} already uses mode ${settings.agentMode}; mode is session-wide and cannot be changed.`
        );
      }
      notebook.touchSession(sessionId);
    } else {
      notebook.createSession(sessionId, options.cwd);
      notebook.getOrCreateModelSession(sessionId, {
        agentMode: options.agentMode ?? 'study'
      });
    }

    const engine = new HeadlessEngine({
      cwd: options.cwd,
      sessionId,
      stateDir,
      experimentStateDir,
      revealExportsInFinder: options.revealExportsInFinder ?? true,
      webSearchMode: options.webSearchMode,
      forceStudyCompactionOnce: options.forceStudyCompactionOnce ?? false,
      notebook,
      authNotebook,
      runner: new PrototypeRunner()
    });
    HeadlessEngine.registerActiveEngine(engine);
    return engine;
  }

  private readonly events = new EventEmitter();
  private readonly experimentManager: ExperimentManager;
  private readonly auth: OpenAICodexAuth;
  private readonly model: ModelClient;
  private readonly tools: AgentTools;
  private processingTurn = false;
  private currentTurnStartedAt: string | null = null;
  private statusText = 'idle';
  private readonly liveTurnEvents: LiveTurnEvent[] = [];
  private readonly liveToolEventIds = new Map<string, string>();
  private readonly execSessions = new Map<number, ExecSession>();
  private lastLiveAssistantText = '';
  private lastLiveThinkingText = '';
  private liveEventCounter = 0;
  private nextExecSessionId = 1;
  private thinkingEnabled = true;
  private turnQueue: Promise<void> = Promise.resolve();
  private lastTestStatus: string | null = null;
  private activeTurnId = 0;
  private lastStudyDebtIntercept: { turnId: number; debtKey: string } | null = null;
  private disposed = false;

  private constructor(
    private readonly options: {
      cwd: string;
      sessionId: string;
      stateDir: string;
      experimentStateDir: string;
      revealExportsInFinder: boolean;
      webSearchMode?: 'disabled' | 'cached' | 'live';
      forceStudyCompactionOnce: boolean;
      notebook: Notebook;
      authNotebook: Notebook;
      runner: AgentRunner;
    }
  ) {
    this.experimentManager = new ExperimentManager({
      cwd: options.cwd,
      stateDir: options.experimentStateDir,
      notebook: options.notebook,
      onChange: () => this.emitChange(),
      onBudgetExceeded: (notification) => this.handleExperimentBudgetExceeded(notification),
      onQualitySignal: (notification) => this.handleExperimentQualitySignal(notification),
      onResolved: (resolution) => this.handleExperimentResolved(resolution),
      startSubagent: (experiment) => this.runExperimentSubagent(experiment)
    });
    this.auth = new OpenAICodexAuth(options.authNotebook);
    this.model = new ModelClient(options.notebook, this.auth);

    this.tools = {
      execCommand: (input) => this.runExecCommand(input),
      writeStdin: (input) => this.runWriteStdin(input),
      read: (filePath, startLine, endLine) => this.runRead(filePath, startLine, endLine),
      ls: (filePath, recursive) => this.runLs(filePath, recursive),
      write: (filePath, content) => this.runWrite(filePath, content),
      edit: (patchText) => this.runEdit(patchText),
      glob: (pattern) => this.runGlob(pattern),
      rg: (pattern, target) => this.runRg(pattern, target),
      grep: (pattern, target) => this.runRg(pattern, target),
      spawnExperiment: (input) => this.spawnExperiment(input),
      extendExperimentBudget: (experimentId, additionalTokens) =>
        this.extendExperimentBudget(experimentId, additionalTokens),
      readExperiment: (experimentId) => this.readExperiment(experimentId),
      waitExperiment: (experimentId, timeoutMs) => this.waitExperiment(experimentId, timeoutMs),
      searchExperiments: (questionId, query) => this.searchExperiments(questionId, query),
      openStudyDebt: (input) => this.openStudyDebt(input),
      resolveStudyDebt: (input) => this.resolveStudyDebt(input),
      narrowStudyDebt: (input) => this.narrowStudyDebt(input),
      exportSession: (sessionId) => this.exportSession(sessionId),
      clearExperimentJournal: (force) => this.clearExperimentJournal(force),
      adoptExperiment: (experimentId, adoptionOptions) =>
        this.adoptExperiment(experimentId, adoptionOptions),
      resolveExperiment: async (input) => this.experimentManager.resolve(input),
      createPlan: (input) => this.createPlan(input),
      askUser: (input) => this.askUser(input),
      updateTodos: (input) => this.updateTodos(input),
      approvePlan: (optionId) => this.approvePlan(optionId),
      getPlanStatus: () => Promise.resolve(this.getPlanStatus()),
      compact: (goal, completed, next, openRisks, currentCommitments, importantNonGoals) =>
        this.runCompact(goal, completed, next, openRisks, currentCommitments, importantNonGoals),
      authLogin: () => this.runAuthLogin(),
      authStatus: () => this.runAuthStatus(),
      authLogout: () => this.runAuthLogout(),
      getModelSettings: () => this.runGetModelSettings(),
      setModel: (model) => this.runSetModel(model),
      setReasoningEffort: (effort) => this.runSetReasoningEffort(effort),
      getThinkingMode: () => this.runGetThinkingMode(),
      setThinkingMode: (enabled) => this.runSetThinkingMode(enabled)
    };
  }

  get snapshot(): EngineSnapshot {
    const contextWindow = this.model.getContextWindowUsage(this.options.sessionId);
    return this.options.notebook.getSnapshot(
      this.options.sessionId,
      this.processingTurn,
      this.currentTurnStartedAt,
      this.statusText,
      contextWindow.usedTokens,
      contextWindow.effectiveBudgetTokens,
      contextWindow.fullContextTokens,
      contextWindow.inputLimitTokens,
      contextWindow.standardRateTokens,
      contextWindow.allowOverStandardContext,
      [...this.liveTurnEvents],
      this.thinkingEnabled
    );
  }

  subscribe(listener: () => void): () => void {
    this.events.on('change', listener);
    return () => {
      this.events.off('change', listener);
    };
  }

  setThinkingEnabled(enabled: boolean): void {
    this.thinkingEnabled = enabled;
    this.emitChange();
  }

  getThinkingEnabled(): boolean {
    return this.thinkingEnabled;
  }

  get notebook(): Notebook {
    return this.options.notebook;
  }

  get modelClient(): ModelClient {
    return this.model;
  }

  get experiments(): ExperimentManager {
    return this.experimentManager;
  }

  getSessionSettings(): ModelSessionRecord {
    return this.options.notebook.getOrCreateModelSession(this.options.sessionId);
  }

  async approvePlan(optionId?: string): Promise<ApprovePlanResult> {
    const settings = this.getSessionSettings();
    if (settings.agentMode !== 'plan') {
      throw new Error('Plan approval is only available in plan mode.');
    }
    if (settings.planModePhase !== 'awaiting_approval') {
      throw new Error('This session is not waiting for plan approval.');
    }

    const plan = this.options.notebook.getSessionPlan(this.options.sessionId);
    if (!plan) {
      throw new Error('No session plan is available to approve.');
    }

    void optionId;
    this.options.notebook.approveSessionPlan(this.options.sessionId);
    this.options.notebook.clearPendingUserRequest(this.options.sessionId);
    this.options.notebook.setPlanModePhase(this.options.sessionId, 'execution');
    this.emitChange();
    return {
      sessionId: this.options.sessionId,
      status: 'execution'
    };
  }

  async askUser(input: AskUserInput): Promise<AskUserResult> {
    const settings = this.getSessionSettings();
    if (settings.agentMode !== 'plan') {
      throw new Error('ask_user is only available in plan mode.');
    }

    validateAskUserInput(input);

    if (input.kind === 'approval' && !this.options.notebook.getSessionPlan(this.options.sessionId)) {
      throw new Error('ask_user approval requests require an existing session plan.');
    }

    const request = this.options.notebook.savePendingUserRequest({
      sessionId: this.options.sessionId,
      kind: input.kind,
      responseKind: input.responseKind,
      question: input.question,
      context: input.context,
      options: input.options ?? null,
      recommendedOptionId: input.recommendedOptionId ?? null,
      recommendedResponse: input.recommendedResponse ?? null,
      reason: input.reason ?? null
    });

    if (input.kind === 'approval') {
      this.options.notebook.setPlanModePhase(this.options.sessionId, 'awaiting_approval');
    }

    this.emitChange();
    return {
      sessionId: this.options.sessionId,
      status: 'waiting_for_user',
      kind: request.kind,
      responseKind: request.responseKind,
      question: request.question,
      options: request.options,
      recommendedOptionId: request.recommendedOptionId,
      recommendedResponse: request.recommendedResponse,
      reason: request.reason
    };
  }

  getPlanStatus(): PlanStatusResult {
    const settings = this.getSessionSettings();
    return {
      phase: settings.planModePhase,
      plan: this.options.notebook.getSessionPlan(this.options.sessionId)
    };
  }

  submit(
    input: string,
    options: {
      onTranscriptEntry?: (role: TranscriptRole, text: string) => Promise<void> | void;
      onAssistantStream?: (text: string) => Promise<void> | void;
      onReasoningSummaryStream?: (text: string) => Promise<void> | void;
    } = {}
  ): Promise<void> {
    const work = this.turnQueue.then(async () => {
      let trimmed = input.trim();
      if (!trimmed) {
        return;
      }

      const pendingUserRequest = this.options.notebook.getPendingUserRequest(this.options.sessionId);
      if (pendingUserRequest) {
        this.options.notebook.clearPendingUserRequest(this.options.sessionId);
        const settings = this.getSessionSettings();
        if (pendingUserRequest.kind === 'approval' && settings.agentMode === 'plan') {
          const answer = parseYesNoAnswer(trimmed);
          if (answer === 'yes') {
            await this.approvePlan();
            trimmed = pendingUserRequest.reason
              ? `The user approved the plan. User response: ${trimmed}\nRecommended rationale: ${pendingUserRequest.reason}`
              : `The user approved the plan. User response: ${trimmed}`;
          } else if (answer === 'no') {
            this.options.notebook.setPlanModePhase(this.options.sessionId, 'planning');
            trimmed = `The user did not approve the current plan. User response: ${trimmed}\nRevise the plan or ask a narrower follow-up if needed.`;
          } else {
            this.options.notebook.setPlanModePhase(this.options.sessionId, 'planning');
            trimmed = `The user responded to the plan request: ${trimmed}\nInterpret this as feedback and continue planning before implementation.`;
          }
        } else if (
          pendingUserRequest.responseKind === 'single_choice' &&
          pendingUserRequest.options?.length
        ) {
          const selected = parseSingleChoiceAnswer(trimmed, pendingUserRequest.options);
          if (selected) {
            trimmed =
              `User selected option for your question:\n` +
              `Question: ${pendingUserRequest.question}\n` +
              `Selected option: ${selected.id} (${selected.label})\n` +
              `Response: ${trimmed}`;
          } else {
            trimmed =
              `User response to your question:\n` +
              `Question: ${pendingUserRequest.question}\n` +
              `Available options: ${pendingUserRequest.options.map((option) => `${option.id} (${option.label})`).join(', ')}\n` +
              `Response: ${trimmed}`;
          }
        } else {
          trimmed =
            `User response to your question:\n` +
            `Question: ${pendingUserRequest.question}\n` +
            `Response: ${trimmed}`;
        }
      }

      this.activeTurnId += 1;
      this.clearLiveTurnState();
      this.processingTurn = true;
      this.currentTurnStartedAt = nowIso();
      this.statusText = 'running turn';
      this.appendTranscript('user', trimmed);
      this.appendModelHistory({
        type: 'message',
        role: 'user',
        content: trimmed
      });

      try {
        const settings = this.getSessionSettings();
        await this.options.runner.runTurn(trimmed, {
          tools: this.tools,
          emit: async (role, text) => {
            this.resetLiveStreamsForTranscriptEntry(role, text);
            this.appendTranscript(role, text);
            this.appendLocalReplayOutput(role, text);
            await options.onTranscriptEntry?.(role, text);
          },
          runModel: async (input) => {
            if (settings.agentMode === 'plan' && settings.planModePhase === 'awaiting_approval') {
              const pendingRequest = this.options.notebook.getPendingUserRequest(this.options.sessionId);
              const recommendation =
                pendingRequest?.responseKind === 'single_choice' &&
                pendingRequest.recommendedOptionId &&
                pendingRequest.reason
                  ? `Recommended option: ${pendingRequest.recommendedOptionId} — ${pendingRequest.reason}`
                  : pendingRequest?.responseKind === 'single_choice' &&
                      pendingRequest.recommendedOptionId
                    ? `Recommended option: ${pendingRequest.recommendedOptionId}`
                    : pendingRequest?.recommendedResponse && pendingRequest.reason
                  ? `Recommended response: ${pendingRequest.recommendedResponse.toUpperCase()} — ${pendingRequest.reason}`
                  : pendingRequest?.recommendedResponse
                    ? `Recommended response: ${pendingRequest.recommendedResponse.toUpperCase()}`
                    : null;
              const optionBlock =
                pendingRequest?.responseKind === 'single_choice' && pendingRequest.options?.length
                  ? `\nOptions:\n${pendingRequest.options
                      .map((option) => `- ${option.id}: ${option.label} — ${option.description}`)
                      .join('\n')}`
                  : '';
              const message =
                `User input required before execution.\n` +
                `${pendingRequest?.question ?? 'Answer the pending plan question to continue.'}` +
                optionBlock +
                `${recommendation ? `\n${recommendation}` : ''}`;
              this.appendTranscript('assistant', message);
              this.appendModelHistory({
                type: 'message',
                role: 'assistant',
                content: message
              });
              await options.onTranscriptEntry?.('assistant', message);
              return;
            }

            const modeConfig = resolveSessionPromptAndTools(settings);
            const emitTranscript = async (role: TranscriptRole, text: string) => {
              this.resetLiveStreamsForTranscriptEntry(role, text);
              this.appendTranscript(role, text);
              await options.onTranscriptEntry?.(role, text);
            };
            const onAssistant = async (text: string) => {
              this.appendLiveTextEvent('assistant', text);
              await options.onAssistantStream?.(text);
            };
            const onThinking = async (text: string) => {
              this.appendLiveTextEvent('thinking', text);
              await options.onReasoningSummaryStream?.(text);
            };
            const onToolStart = async (toolCall: {
              toolCallId: string;
              toolName: string;
              label: string;
              detail?: string | null;
              body?: string[];
              providerExecuted?: boolean;
            }) => {
              this.startLiveToolCall(toolCall);
            };
            const onToolFinish = async (toolCallId: string, transcriptText?: string) => {
              this.finishLiveToolCall(toolCallId, transcriptText);
            };

            if (this.options.webSearchMode === undefined) {
              await (this.model.runTurn as (...args: any[]) => Promise<void>)(
                this.options.sessionId,
                input,
                this.tools,
                emitTranscript,
                onAssistant,
                onThinking,
                this.thinkingEnabled,
                modeConfig.toolDefinitions,
                modeConfig.instructions,
                onToolStart,
                onToolFinish,
                settings.agentMode !== 'study',
                () => this.buildHiddenCompactionStateSnapshot(settings),
                this.options.forceStudyCompactionOnce
              );
            } else {
              await this.model.runTurn(
                this.options.sessionId,
                input,
                this.tools,
                emitTranscript,
                onAssistant,
                onThinking,
                this.thinkingEnabled,
                this.options.webSearchMode,
                modeConfig.toolDefinitions,
                modeConfig.instructions,
                onToolStart,
                onToolFinish,
                settings.agentMode !== 'study',
                () => this.buildHiddenCompactionStateSnapshot(settings),
                this.options.forceStudyCompactionOnce
              );
            }
          }
        });
        this.statusText = 'idle';
      } catch (error) {
        const message = formatUnknownError(error);
        const errorText = `Error: ${message}`;
        this.appendTranscript('assistant', errorText);
        this.appendModelHistory({
          type: 'message',
          role: 'assistant',
          content: errorText
        });
        await options.onTranscriptEntry?.('assistant', errorText);
        this.statusText = 'error';
      } finally {
        this.processingTurn = false;
        this.emitChange();
      }
    });

    this.turnQueue = work.catch(() => undefined);
    return work;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    HeadlessEngine.unregisterActiveEngine(this);
    await this.disposeExecSessions();
    await this.experimentManager.dispose();
    this.options.notebook.close();
    this.options.authNotebook.close();
  }

  private static registerActiveEngine(engine: HeadlessEngine): void {
    HeadlessEngine.activeEngines.add(engine);
    HeadlessEngine.installShutdownHooks();
  }

  private static unregisterActiveEngine(engine: HeadlessEngine): void {
    HeadlessEngine.activeEngines.delete(engine);
  }

  private static installShutdownHooks(): void {
    if (HeadlessEngine.shutdownHooksInstalled) {
      return;
    }
    HeadlessEngine.shutdownHooksInstalled = true;

    const cleanup = () => {
      HeadlessEngine.runProcessExitCleanup();
    };

    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGHUP', cleanup);
    process.on('uncaughtException', cleanup);
  }

  private static runProcessExitCleanup(): void {
    if (HeadlessEngine.exitCleanupRan) {
      return;
    }
    HeadlessEngine.exitCleanupRan = true;
    for (const engine of HeadlessEngine.activeEngines) {
      try {
        engine.forceKillOwnedProcessesSync();
      } catch {}
    }
  }

  private appendTranscript(role: TranscriptRole, text: string): void {
    this.options.notebook.appendTranscript(this.options.sessionId, role, text);
    this.emitChange();
  }

  private async buildHiddenCompactionStateSnapshot(
    settings: ModelSessionRecord
  ): Promise<HiddenCompactionStateSnapshot> {
    const activeProcessSummary = [...this.execSessions.values()]
      .filter((session) => session.running)
      .map((session) => {
        const command = clampText(session.command, 120);
        const cwd = relativeToWorkspace(session.root, session.cwd);
        return `${command} | cwd ${cwd} | process ${session.id}`;
      });

    return {
      mode: settings.agentMode === 'plan' ? 'plan' : 'direct',
      planModePhase: settings.planModePhase,
      approvedPlan: this.options.notebook.getSessionPlan(this.options.sessionId),
      todos: this.options.notebook.listSessionTodos(this.options.sessionId),
      lastTestStatus: this.lastTestStatus,
      activeProcessSummary,
      experimentState: null
    };
  }

  private async buildExperimentCompactionStateSnapshot(
    experiment: ExperimentRecord
  ): Promise<HiddenCompactionStateSnapshot> {
    const activeProcessSummary = [...this.execSessions.values()]
      .filter((session) => session.running && session.root === experiment.worktreePath)
      .map((session) => {
        const command = clampText(session.command, 120);
        const cwd = relativeToWorkspace(session.root, session.cwd);
        return `${command} | cwd ${cwd} | process ${session.id}`;
      });

    return {
      mode: 'experiment',
      planModePhase: null,
      approvedPlan: null,
      todos: [],
      lastTestStatus: null,
      activeProcessSummary,
      experimentState: {
        id: experiment.id,
        hypothesis: experiment.hypothesis,
        budget: experiment.budget,
        tokensUsed: experiment.tokensUsed,
        worktreePath: experiment.worktreePath,
        branchName: experiment.branchName
      }
    };
  }

  private startLiveToolCall(input: {
    toolCallId: string;
    toolName: string;
    label: string;
    detail?: string | null;
    body?: string[];
    providerExecuted?: boolean;
  }): void {
    const eventId = this.createLiveEventId('tool');
    this.liveTurnEvents.push({
      id: eventId,
      kind: 'tool',
      transcriptText: null,
      live: true,
      callId: input.toolCallId,
      toolName: input.toolName,
      label: input.label,
      detail: input.detail ?? null,
      body: input.body ?? [],
      providerExecuted: input.providerExecuted ?? false
    });
    this.liveToolEventIds.set(input.toolCallId, eventId);
    this.emitChange();
  }

  private finishLiveToolCall(toolCallId: string, transcriptText?: string): void {
    const eventId = this.liveToolEventIds.get(toolCallId);
    if (!eventId) {
      if (transcriptText) {
        this.appendCompletedToolEvent(transcriptText);
      }
      return;
    }

    const event = this.liveTurnEvents.find(
      (candidate) => candidate.id === eventId && candidate.kind === 'tool'
    ) as Extract<LiveTurnEvent, { kind: 'tool' }> | undefined;
    if (event) {
      event.live = false;
      event.transcriptText = transcriptText ?? event.transcriptText;
      event.detail = null;
      event.body = [];
      event.label = null;
      event.toolName = null;
      this.emitChange();
    }
    this.liveToolEventIds.delete(toolCallId);
  }

  private appendModelHistory(item: ModelHistoryItem): void {
    this.options.notebook.appendModelHistoryItem(this.options.sessionId, item);
  }

  private resetLiveStreamsForTranscriptEntry(role: TranscriptRole, text: string): void {
    if (!this.processingTurn) {
      return;
    }

    if (role === 'system' && text.startsWith('@@thinking\t')) {
      this.finalizeLiveTextEvent('thinking', text.slice('@@thinking\t'.length));
      return;
    }

    if (role === 'assistant') {
      this.finalizeLiveTextEvent('assistant', text);
      return;
    }

    if (role === 'tool') {
      const hasActiveTrackedTool = this.liveTurnEvents.some(
        (event) => event.kind === 'tool' && event.live
      );
      if (!hasActiveTrackedTool) {
        this.appendCompletedToolEvent(text);
      }
    }
  }

  private appendLocalReplayOutput(role: TranscriptRole, text: string): void {
    if (role === 'assistant' || role === 'system') {
      if (role === 'system' && text.startsWith('@@thinking\t')) {
        return;
      }
      this.appendModelHistory({
        type: 'message',
        role: role === 'system' ? 'developer' : role,
        content: text
      });
      return;
    }

    if (role === 'tool') {
      this.appendModelHistory({
        type: 'message',
        role: 'assistant',
        content: `Tool output:\n${text}`
      });
    }
  }

  private emitChange(): void {
    this.events.emit('change');
  }

  private clearLiveTurnState(): void {
    this.liveTurnEvents.length = 0;
    this.liveToolEventIds.clear();
    this.lastLiveAssistantText = '';
    this.lastLiveThinkingText = '';
  }

  private appendLiveTextEvent(kind: 'assistant' | 'thinking', fullText: string): void {
    const previous = kind === 'assistant' ? this.lastLiveAssistantText : this.lastLiveThinkingText;
    const nextChunk = fullText.startsWith(previous) ? fullText.slice(previous.length) : fullText;
    if (!nextChunk) {
      return;
    }

    const lastEvent = this.liveTurnEvents.at(-1);
    if (lastEvent && lastEvent.kind === kind && lastEvent.live) {
      lastEvent.text += nextChunk;
    } else {
      this.liveTurnEvents.push({
        id: this.createLiveEventId(kind),
        kind,
        text: nextChunk,
        live: true
      });
    }

    if (kind === 'assistant') {
      this.lastLiveAssistantText = fullText;
    } else {
      this.lastLiveThinkingText = fullText;
    }
    this.emitChange();
  }

  private finalizeLiveTextEvent(kind: 'assistant' | 'thinking', finalText: string): void {
    const liveEvents = this.liveTurnEvents.filter(
      (event): event is Extract<LiveTurnEvent, { kind: 'assistant' | 'thinking' }> =>
        event.kind === kind && event.live
    );

    if (liveEvents.length > 0) {
      for (const event of liveEvents) {
        event.live = false;
      }
    } else if (finalText.trim()) {
      this.liveTurnEvents.push({
        id: this.createLiveEventId(kind),
        kind,
        text: finalText,
        live: false
      });
    }

    if (kind === 'assistant') {
      this.lastLiveAssistantText = '';
    } else {
      this.lastLiveThinkingText = '';
    }
    this.emitChange();
  }

  private appendCompletedToolEvent(transcriptText: string): void {
    this.liveTurnEvents.push({
      id: this.createLiveEventId('tool'),
      kind: 'tool',
      transcriptText,
      live: false,
      callId: null,
      toolName: null,
      label: null,
      detail: null,
      body: [],
      providerExecuted: false
    });
    this.emitChange();
  }

  private createLiveEventId(kind: 'assistant' | 'thinking' | 'tool'): string {
    this.liveEventCounter += 1;
    return `live-${kind}-${this.liveEventCounter}`;
  }

  async runExecCommand(input: ExecCommandInput): Promise<string> {
    return this.runExecCommandAtRoot(this.options.cwd, input);
  }

  async runWriteStdin(input: WriteStdinInput): Promise<string> {
    return this.runWriteStdinAtRoot(this.options.cwd, input);
  }

  async runRead(filePath: string, startLine?: number, endLine?: number): Promise<string> {
    return this.runReadAtRoot(this.options.cwd, filePath, startLine, endLine);
  }

  async runLs(filePath = '.', recursive = false): Promise<string> {
    return this.runLsAtRoot(this.options.cwd, filePath, recursive);
  }

  async runWrite(filePath: string, content: string): Promise<string> {
    return this.runWriteAtRoot(this.options.cwd, filePath, content);
  }

  async runEdit(patchText: string): Promise<string> {
    return this.runEditAtRoot(this.options.cwd, patchText);
  }

  async runGlob(patternText: string): Promise<string[]> {
    return this.runGlobAtRoot(this.options.cwd, patternText);
  }

  async runRg(patternText: string, target: string | string[] = '.'): Promise<string> {
    return this.runRgAtRoot(this.options.cwd, patternText, target);
  }

  private async runExecCommandAtRoot(root: string, input: ExecCommandInput): Promise<string> {
    const command = input.command.trim();
    if (!command) {
      throw new Error('exec_command requires a non-empty command.');
    }

    const cwd = input.cwd ? this.resolveRootedPath(root, input.cwd) : root;
    this.assertExperimentAllowsInlineProbe(root, 'exec_command', [cwd]);
    const probeQuestionIds = this.consumeInlineProbeBudget(root, 'exec_command', [cwd]);

    const session = this.startExecSession(root, cwd, command, probeQuestionIds);
    for (const questionId of probeQuestionIds) {
      this.options.notebook.incrementStudyDebtProbeEpisodeCount(questionId);
    }
    await this.waitForExecSession(session, normalizeExecYieldTime(input.yieldTimeMs));

    const result = this.collectExecCommandResult(session, command, cwd, input.maxOutputChars);
    return JSON.stringify(result, null, 2);
  }

  private async runWriteStdinAtRoot(root: string, input: WriteStdinInput): Promise<string> {
    const session = this.execSessions.get(input.processId);
    if (!session || session.root !== root) {
      throw new Error(`Unknown process: ${input.processId}`);
    }

    if (!input.terminate) {
      this.assertExperimentAllowsInlineProbe(root, 'write_stdin', [session.cwd]);
      this.assertInlineProbeContinuationAllowed(root, session);
    }

    if (input.terminate) {
      await this.terminateExecSession(session);
    } else {
      if (input.input) {
        if (!session.running) {
          throw new Error(`Process ${input.processId} is no longer running.`);
        }
        if (!session.stdinOpen || session.child.stdin.destroyed || !session.child.stdin.writable) {
          throw new Error(`stdin is closed for process ${input.processId}.`);
        }
        session.child.stdin.write(input.input);
      }

      if (input.closeStdin && session.stdinOpen && !session.child.stdin.destroyed) {
        session.stdinOpen = false;
        session.child.stdin.end();
      }

      await this.waitForExecSession(session, normalizeExecYieldTime(input.yieldTimeMs));
    }

    const result = this.collectWriteStdinResult(session, input.maxOutputChars);
    return JSON.stringify(result, null, 2);
  }

  private async runReadAtRoot(
    root: string,
    filePath: string,
    startLine?: number,
    endLine?: number
  ): Promise<string> {
    const resolvedPath = this.resolveRootedPath(root, filePath);
    this.assertExperimentAllowsInlineProbe(root, 'read', [resolvedPath]);
    const content = await readFile(resolvedPath, 'utf8');
    const allLines = content.split(/\r?\n/);
    const totalLines = allLines.length;
    const normalizedStart = normalizeReadStartLine(startLine);
    const normalizedEnd = normalizeReadEndLine(normalizedStart, endLine, totalLines);
    const slice = allLines.slice(normalizedStart - 1, normalizedEnd);
    const numberedSlice = slice.map((line, index) => `${normalizedStart + index}: ${line}`);
    return [
      `${relativeToWorkspace(root, resolvedPath)} (lines ${normalizedStart}-${normalizedEnd} of ${totalLines})`,
      '',
      clampText(numberedSlice.join('\n'), 12000)
    ].join('\n');
  }

  async runEditAtRoot(root: string, patchText: string): Promise<string> {
    return executeEditPatch(patchText, {
      resolvePath: (filePath) => this.resolveRootedPath(root, filePath),
      assertCanMutate: (resolvedPath) => this.assertStudyDebtAllowsMutation(root, resolvedPath),
      ensureParentDir: async (resolvedPath) => {
        await mkdir(path.dirname(resolvedPath), { recursive: true });
      },
      readFile: (resolvedPath) => readFile(resolvedPath, 'utf8'),
      writeFile: (resolvedPath, content) => writeFile(resolvedPath, content, 'utf8'),
      removeFile: (resolvedPath) => rm(resolvedPath, { force: false })
    });
  }

  private async runGlobAtRoot(root: string, patternText: string): Promise<string[]> {
    this.assertExperimentAllowsInlineProbe(root, 'glob');
    const matches: string[] = [];
    for await (const entry of glob(patternText, { cwd: root })) {
      matches.push(entry);
    }

    return matches
      .filter((entry) => !entry.startsWith('.git/') && !entry.startsWith('.h2/'))
      .sort();
  }

  async runWriteAtRoot(root: string, filePath: string, content: string): Promise<string> {
    const resolvedPath = this.resolveRootedPath(root, filePath);
    this.assertStudyDebtAllowsMutation(root, resolvedPath);
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, content, 'utf8');
    return `Wrote ${content.length} chars to ${relativeToWorkspace(root, resolvedPath)}.`;
  }

  private async runLsAtRoot(root: string, filePath = '.', recursive = false): Promise<string> {
    const targetPath = this.resolveRootedPath(root, filePath);
    this.assertExperimentAllowsInlineProbe(root, 'ls', [targetPath]);
    const command = recursive ? `ls -laR ${shellQuote(targetPath)}` : `ls -la ${shellQuote(targetPath)}`;
    const result = await execaCommand(command, {
      cwd: root,
      shell: true,
      reject: false
    });

    return formatCommandResult(
      command,
      result.exitCode ?? 1,
      result.stdout,
      result.stderr
    );
  }

  private async runRgAtRoot(
    root: string,
    patternText: string,
    target: string | string[] = '.'
  ): Promise<string> {
    const targets = await normalizeRgTargets(root, target);
    const resolvedTargets = targets
      .filter((entry) => entry !== '.')
      .map((entry) => this.resolveRootedPath(root, entry));
    this.assertExperimentAllowsInlineProbe(root, 'rg', resolvedTargets);
    try {
      const result = await execa(
        'rg',
        [
          '-n',
          '--hidden',
          '--glob',
          '!.git',
          '--glob',
          '!.h2',
          patternText,
          ...targets
        ],
        {
          cwd: root,
          reject: false
        }
      );

      if (result.exitCode === 1 && !result.stderr.trim()) {
        return `No matches for ${patternText}.`;
      }

      return formatCommandResult(
        `rg -n --hidden ${patternText} ${targets.join(' ')}`,
        result.exitCode ?? 1,
        result.stdout,
        result.stderr
      );
    } catch (error) {
      const result = await execa('grep', ['-R', '-n', patternText, ...targets], {
        cwd: root,
        reject: false
      });

      return formatCommandResult(
        `grep -R -n ${patternText} ${targets.join(' ')}`,
        result.exitCode ?? 1,
        result.stdout,
        result.stderr
      );
    }
  }

  private startExecSession(
    root: string,
    cwd: string,
    command: string,
    probeQuestionIds: string[]
  ): ExecSession {
    const child = spawn(DEFAULT_COMMAND_SHELL, ['-lc', command], {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let resolveWaitForExit: () => void = () => {};
    const waitForExit = new Promise<void>((resolve) => {
      resolveWaitForExit = resolve;
    });

    const session: ExecSession = {
      id: this.nextExecSessionId++,
      command,
      cwd,
      root,
      probeQuestionIds,
      child,
      pendingStdout: '',
      pendingStderr: '',
      droppedStdoutChars: 0,
      droppedStderrChars: 0,
      capturedStdout: '',
      capturedStderr: '',
      exitCode: null,
      running: true,
      stdinOpen: true,
      updateLastTestStatus: root === this.options.cwd,
      waitForExit,
      resolveWaitForExit,
      outputWaiters: []
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      this.appendExecSessionOutput(session, 'stdout', String(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.appendExecSessionOutput(session, 'stderr', String(chunk));
    });
    child.on('error', (error) => {
      this.appendExecSessionOutput(session, 'stderr', `${error.message}\n`);
    });
    child.on('close', (exitCode) => {
      session.running = false;
      session.stdinOpen = false;
      session.exitCode = exitCode ?? 1;
      this.resolveExecOutputWaiters(session);
      session.resolveWaitForExit();
    });

    this.execSessions.set(session.id, session);
    return session;
  }

  private appendExecSessionOutput(
    session: ExecSession,
    stream: 'stdout' | 'stderr',
    chunk: string
  ): void {
    if (!chunk) {
      return;
    }

    if (stream === 'stdout') {
      const pending = appendCappedText(
        session.pendingStdout,
        chunk,
        MAX_EXEC_PENDING_OUTPUT_CHARS
      );
      session.pendingStdout = pending.text;
      session.droppedStdoutChars += pending.droppedChars;
      session.capturedStdout = appendCappedTail(
        session.capturedStdout,
        chunk,
        MAX_EXEC_CAPTURED_OUTPUT_CHARS
      );
      this.resolveExecOutputWaiters(session);
      return;
    }

    const pending = appendCappedText(session.pendingStderr, chunk, MAX_EXEC_PENDING_OUTPUT_CHARS);
    session.pendingStderr = pending.text;
    session.droppedStderrChars += pending.droppedChars;
    session.capturedStderr = appendCappedTail(
      session.capturedStderr,
      chunk,
      MAX_EXEC_CAPTURED_OUTPUT_CHARS
    );
    this.resolveExecOutputWaiters(session);
  }

  private async waitForExecSession(session: ExecSession, yieldTimeMs: number): Promise<void> {
    if (!session.running) {
      return;
    }

    await Promise.race([session.waitForExit, delay(yieldTimeMs)]);
    if (session.running && !this.execSessionHasOutput(session)) {
      await Promise.race([
        session.waitForExit,
        this.waitForExecOutput(session),
        delay(Math.max(750, Math.min(2_500, yieldTimeMs * 25)))
      ]);
    }
  }

  private execSessionHasOutput(session: ExecSession): boolean {
    return (
      session.pendingStdout.length > 0 ||
      session.pendingStderr.length > 0 ||
      session.capturedStdout.length > 0 ||
      session.capturedStderr.length > 0
    );
  }

  private waitForExecOutput(session: ExecSession): Promise<void> {
    if (this.execSessionHasOutput(session) || !session.running) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      session.outputWaiters.push(resolve);
    });
  }

  private resolveExecOutputWaiters(session: ExecSession): void {
    if (session.outputWaiters.length === 0) {
      return;
    }

    const waiters = session.outputWaiters.splice(0, session.outputWaiters.length);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private collectExecCommandResult(
    session: ExecSession,
    command: string,
    cwd: string,
    maxOutputChars?: number
  ): ExecCommandResult {
    const outputLimit = normalizeExecOutputChars(maxOutputChars);
    const stdout = drainExecOutput(session, 'stdout', outputLimit);
    const stderr = drainExecOutput(session, 'stderr', outputLimit);
    const processId = this.maybeFinalizeExecSession(session);

    return {
      processId,
      exitCode: session.running ? null : session.exitCode,
      stdout,
      stderr,
      running: session.running,
      command,
      cwd: relativeToWorkspace(session.root, cwd)
    };
  }

  private collectWriteStdinResult(
    session: ExecSession,
    maxOutputChars?: number
  ): WriteStdinResult {
    const outputLimit = normalizeExecOutputChars(maxOutputChars);
    const stdout = drainExecOutput(session, 'stdout', outputLimit);
    const stderr = drainExecOutput(session, 'stderr', outputLimit);
    const processId = this.maybeFinalizeExecSession(session);

    return {
      processId,
      exitCode: session.running ? null : session.exitCode,
      stdout,
      stderr,
      running: session.running
    };
  }

  private maybeFinalizeExecSession(session: ExecSession): number | null {
    if (session.running || session.pendingStdout.length > 0 || session.pendingStderr.length > 0) {
      return session.id;
    }

    this.execSessions.delete(session.id);
    if (session.updateLastTestStatus) {
      this.updateLastTestStatus(
        session.command,
        session.exitCode ?? 1,
        session.capturedStdout,
        session.capturedStderr
      );
    }
    return null;
  }

  private async terminateExecSession(session: ExecSession): Promise<void> {
    if (!session.running) {
      return;
    }

    if (process.platform === 'win32') {
      if (typeof session.child.pid === 'number') {
        await execa('taskkill', ['/PID', String(session.child.pid), '/T', '/F'], {
          reject: false
        });
      } else {
        session.child.kill('SIGTERM');
      }
      await Promise.race([session.waitForExit, delay(1_500)]);
      return;
    }

    const processId = session.child.pid;
    try {
      if (typeof processId === 'number') {
        process.kill(-processId, 'SIGTERM');
      } else {
        session.child.kill('SIGTERM');
      }
    } catch {}

    const exited = await Promise.race([
      session.waitForExit.then(() => true),
      delay(1_500).then(() => false)
    ]);
    if (exited) {
      return;
    }

    try {
      if (typeof processId === 'number') {
        process.kill(-processId, 'SIGKILL');
      } else {
        session.child.kill('SIGKILL');
      }
    } catch {}
    await Promise.race([session.waitForExit, delay(1_500)]);
  }

  private forceKillOwnedProcessesSync(): void {
    const sessions = [...this.execSessions.values()];
    for (const session of sessions) {
      this.killExecSessionSync(session);
    }
    this.execSessions.clear();
  }

  private killExecSessionSync(session: ExecSession): void {
    if (!session.running) {
      return;
    }

    const processId = session.child.pid;
    try {
      if (process.platform === 'win32') {
        session.child.kill('SIGKILL');
      } else if (typeof processId === 'number') {
        process.kill(-processId, 'SIGKILL');
      } else {
        session.child.kill('SIGKILL');
      }
    } catch {
      try {
        session.child.kill('SIGKILL');
      } catch {}
    }

    session.running = false;
    session.stdinOpen = false;
    session.exitCode ??= 137;
    this.resolveExecOutputWaiters(session);
    session.resolveWaitForExit();
  }

  private async disposeExecSessions(): Promise<void> {
    const sessions = [...this.execSessions.values()];
    await Promise.all(sessions.map((session) => this.terminateExecSession(session)));
    this.execSessions.clear();
  }

  async spawnExperiment(
    input: Omit<SpawnExperimentInput, 'sessionId'> & { questionId?: string }
  ): Promise<ExperimentRecord> {
    const questionId = input.questionId ?? input.studyDebtId;
    const openDebts = this.options.notebook.listOpenStudyDebts(this.options.sessionId);
    if (openDebts.length > 0 && !questionId) {
      throw new Error(
        [
          'An open question exists, so this experiment must be tied to a question.',
          `open_questions: ${openDebts.map((debt) => debt.id).join(', ')}`,
          'If this experiment is meant to reduce one of those uncertainties, pass questionId.',
          'If you discovered a different unresolved uncertainty, open a new question for it first.'
        ].join('\n')
      );
    }

    if (questionId) {
      const studyDebt = this.options.notebook.getStudyDebt(questionId);
      if (!studyDebt || studyDebt.sessionId !== this.options.sessionId) {
        throw new Error(`Unknown question: ${questionId}`);
      }

      if (studyDebt.status !== 'open') {
        throw new Error(`Question ${questionId} is already closed.`);
      }

      const activeLinkedExperiments =
        this.options.notebook.listActiveExperimentsForStudyDebt(questionId);
      if (activeLinkedExperiments.length > 0) {
        throw new Error(
          [
            `Question ${questionId} already has an active linked experiment ${activeLinkedExperiments
              .map((experiment) => experiment.id)
              .join(', ')}.`,
            'Wait for that experiment to resolve before spawning another on the same question.',
            'If you discovered a different orthogonal risk, open a separate question for it first.'
          ].join('\n')
        );
      }
    }

    const localEvidenceSummary =
      input.localEvidenceSummary?.trim() ||
      this.deriveExperimentLocalEvidenceSummary(questionId ?? null);

    if (!localEvidenceSummary) {
      throw new Error(
        'spawn_experiment needs local evidence context. Tie it to questionId or provide localEvidenceSummary explicitly.'
      );
    }

    return this.experimentManager.spawn({
      ...input,
      localEvidenceSummary,
      studyDebtId: questionId,
      sessionId: this.options.sessionId
    });
  }

  private async extendExperimentBudget(
    experimentId: string,
    additionalTokens: number
  ): Promise<ExperimentRecord> {
    return this.experimentManager.extendBudget(experimentId, additionalTokens);
  }

  private async readExperiment(experimentId: string): Promise<ExperimentDetails> {
    return this.experimentManager.read(experimentId);
  }

  private async waitExperiment(
    experimentId: string,
    timeoutMs?: number
  ): Promise<ExperimentWaitResult> {
    return this.experimentManager.waitForResolution(experimentId, timeoutMs);
  }

  async searchExperiments(
    questionId: string,
    query?: string
  ): Promise<ExperimentSearchResult[] | ExperimentSearchGuardrail> {
    const openDebts = this.options.notebook.listOpenStudyDebts(this.options.sessionId);
    if (openDebts.length === 0) {
      return {
        ok: false,
        guardrail:
          'search_experiments is subordinate to the current task. Open the live question first, then search from that question context.',
        suggestedNext: [
          'Name the implementation-changing uncertainty.',
          'Open the question if dependent edits rely on it.',
          'Then search for prior findings only if they may answer or narrow that same question.'
        ]
      };
    }

    const currentDebt = openDebts.find((debt) => debt.id === questionId);
    if (!currentDebt) {
      return {
        ok: false,
        guardrail:
          'search_experiments requires the current open questionId. Tie the search to one live question before looking up prior experiments.',
        suggestedNext: [
          `Open questions: ${openDebts.map((debt) => debt.id).join(', ')}`,
          'Choose the question whose claim this search is trying to answer.',
          'Then search for prior findings only if they may answer or narrow that same question.'
        ]
      };
    }

    return this.experimentManager.search(this.options.sessionId, query);
  }

  async openStudyDebt(input: {
    summary: string;
    whyItMatters: string;
    kind?: StudyDebtKind;
    affectedPaths: string[];
    evidencePaths?: string[];
    recommendedStudy?: string;
  }): Promise<{
    questionId: string;
    status: 'open';
    summary: string;
    kind: StudyDebtKind;
  }> {
    validateStudyDebtPaths(this.options.cwd, input.affectedPaths, input.evidencePaths);
    const record = this.options.notebook.openStudyDebt({
      sessionId: this.options.sessionId,
      summary: input.summary,
      whyItMatters: input.whyItMatters,
      kind: input.kind,
      affectedPaths: input.affectedPaths,
      evidencePaths: input.evidencePaths,
      recommendedStudy: input.recommendedStudy
    });
    this.emitChange();
    return {
      questionId: record.id,
      status: 'open',
      summary: record.summary,
      kind: record.kind
    };
  }

  async resolveStudyDebt(input: {
    questionId: string;
    resolution: StudyDebtResolution;
    note: string;
  }): Promise<{
    questionId: string;
    status: 'closed';
    summary: string;
    resolution: StudyDebtResolution;
    note: string;
  }> {
    const record = this.options.notebook.resolveStudyDebt({
      questionId: input.questionId,
      resolution: input.resolution,
      note: input.note
    });
    this.emitChange();
    return {
      questionId: record.id,
      status: 'closed',
      summary: record.summary,
      resolution: record.resolution ?? input.resolution,
      note: record.resolutionNote ?? input.note
    };
  }

  async narrowStudyDebt(input: {
    questionId: string;
    summary: string;
    whyItMatters: string;
    kind?: StudyDebtKind;
    affectedPaths: string[];
    evidencePaths?: string[];
    recommendedStudy?: string;
    note: string;
  }): Promise<{
    previousQuestionId: string;
    status: 'narrowed';
    questionId: string;
    summary: string;
    kind: StudyDebtKind;
  }> {
    const existing = this.options.notebook.getStudyDebt(input.questionId);
    if (!existing || existing.sessionId !== this.options.sessionId) {
      throw new Error(`Unknown question: ${input.questionId}`);
    }
    if (existing.status !== 'open') {
      throw new Error(`Question ${input.questionId} is already closed.`);
    }

    await this.resolveStudyDebt({
      questionId: input.questionId,
      resolution: 'scope_narrowed',
      note: input.note
    });
    const next = await this.openStudyDebt({
      summary: input.summary,
      whyItMatters: input.whyItMatters,
      kind: input.kind ?? existing.kind,
      affectedPaths: input.affectedPaths,
      evidencePaths: input.evidencePaths,
      recommendedStudy: input.recommendedStudy
    });
    return {
      previousQuestionId: input.questionId,
      status: 'narrowed',
      questionId: next.questionId,
      summary: next.summary,
      kind: next.kind
    };
  }

  private deriveExperimentLocalEvidenceSummary(questionId: string | null): string {
    if (!questionId) {
      return '';
    }

    const debt = this.options.notebook.getStudyDebt(questionId);
    if (!debt) {
      return '';
    }

    const transcript = this.options.notebook
      .listTranscript(this.options.sessionId, 40)
      .filter((entry) => entry.createdAt >= debt.openedAt)
      .filter((entry) => entry.role === 'tool' || entry.role === 'assistant')
      .map((entry) => entry.text.split('\n')[0]?.trim())
      .filter((line): line is string => Boolean(line) && !line.startsWith('@@thinking\t'))
      .slice(-4);

    const facts = [
      `Open question: ${debt.summary}.`,
      `Why it matters: ${debt.whyItMatters}.`,
      debt.affectedPaths && debt.affectedPaths.length > 0
        ? `Affected paths: ${debt.affectedPaths.join(', ')}.`
        : null,
      debt.evidencePaths && debt.evidencePaths.length > 0
        ? `Evidence paths: ${debt.evidencePaths.join(', ')}.`
        : null,
      debt.recommendedStudy ? `Suggested study focus: ${debt.recommendedStudy}.` : null,
      transcript.length > 0 ? `Recent evidence: ${transcript.join(' | ')}` : null
    ].filter((line): line is string => Boolean(line));

    return facts.join(' ');
  }

  async createPlan(input: CreatePlanInput): Promise<CreatePlanResult> {
    const settings = this.getSessionSettings();
    if (settings.agentMode !== 'plan') {
      throw new Error('create_plan is only available in plan mode.');
    }
    if (settings.planModePhase !== 'planning') {
      throw new Error('create_plan is only available during the planning phase.');
    }

    validateCreatePlanInput(input);
    const planDir = path.join(this.options.cwd, '.h2', 'plans');
    await mkdir(planDir, { recursive: true });
    const planPath = path.join(planDir, `${this.options.sessionId}.md`);
    await writeFile(planPath, input.planMarkdown, 'utf8');
    this.options.notebook.saveSessionPlan({
      sessionId: this.options.sessionId,
      goal: input.goal,
      assumptions: input.assumptions,
      files: input.files,
      steps: input.steps,
      validation: input.validation,
      risks: input.risks,
      planPath
    });
    this.options.notebook.setPlanModePhase(this.options.sessionId, 'execution');
    this.emitChange();
    return {
      sessionId: this.options.sessionId,
      status: 'planned',
      planPath
    };
  }

  async updateTodos(input: UpdateTodosInput): Promise<UpdateTodosResult> {
    const settings = this.getSessionSettings();
    if (settings.agentMode === 'study') {
      throw new Error('update_todos is not available in study mode.');
    }

    validateTodoItems(input.items);
    const todos = this.options.notebook.replaceSessionTodos(
      this.options.sessionId,
      input.items.map((item, index) => ({
        id: item.id,
        text: item.text,
        status: item.status,
        position: index
      }))
    );
    this.emitChange();
    return { items: todos };
  }

  private async clearExperimentJournal(
    force = false
  ): Promise<{ clearedExperiments: number; clearedObservations: number; blockedActive: number }> {
    return this.options.notebook.clearExperimentJournal(this.options.sessionId, { force });
  }

  private async exportSession(sessionId = this.options.sessionId): Promise<SessionExportResult> {
    const session = this.options.notebook.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    const transcript = this.options.notebook.listTranscript(sessionId, Number.MAX_SAFE_INTEGER);
    const experiments = this.options.notebook.listExperiments(sessionId);
    const studyDebts = this.options.notebook.listStudyDebts(sessionId);
    const exportDir = path.join(session.cwd, '.h2', 'session-exports');
    const exportPath = path.join(exportDir, `${sessionId}.md`);

    await mkdir(exportDir, { recursive: true });
    await writeFile(
      exportPath,
      renderSessionExport({
        session,
        transcript,
        experiments,
        studyDebts
      }),
      'utf8'
    );

    return {
      sessionId,
      exportPath,
      revealedInFinder: this.options.revealExportsInFinder
        ? (
            await execa('open', ['-R', exportPath], {
              cwd: session.cwd,
              reject: false
            })
          ).exitCode === 0
        : false
    };
  }

  private async adoptExperiment(
    experimentId: string,
    options: { apply?: boolean } = {}
  ): Promise<ExperimentAdoptionPreview | ExperimentAdoptionResult> {
    const experiment = await this.experimentManager.read(experimentId);
    if (!experiment.promote) {
      throw new Error(`Experiment ${experimentId} is not marked for adoption.`);
    }

    const worktreePath = experiment.worktreePath;
    const worktreeStatus = await execa('git', ['status', '--short'], {
      cwd: worktreePath,
      reject: false
    });
    if (worktreeStatus.exitCode !== 0) {
      throw new Error(`Experiment worktree is unavailable: ${clampText(worktreeStatus.stderr || worktreeStatus.stdout, 300)}`);
    }

    const changedTracked = await this.readLines(worktreePath, [
      'git',
      'diff',
      '--name-only',
      experiment.baseCommitSha
    ]);
    const untrackedFiles = await this.readLines(worktreePath, [
      'git',
      'ls-files',
      '--others',
      '--exclude-standard'
    ]);
    const changedFiles = Array.from(new Set([...changedTracked, ...untrackedFiles])).sort();
    const diffStatSections: string[] = [];
    const trackedDiffStat = await this.readCommandOutput(worktreePath, [
      'git',
      'diff',
      '--stat',
      experiment.baseCommitSha
    ]);
    if (trackedDiffStat.trim()) {
      diffStatSections.push(trackedDiffStat.trim());
    }
    if (untrackedFiles.length > 0) {
      diffStatSections.push(`untracked:\n${untrackedFiles.join('\n')}`);
    }

    const patchDir = path.join(this.options.stateDir, 'adoptions');
    await mkdir(patchDir, { recursive: true });
    const patchPath = path.join(patchDir, `${experiment.id}.patch`);
    const rollbackBranchName = `h2-adopt-backup-${experiment.id.slice(4, 12)}-${Date.now().toString(36)}`;
    const patch = await this.buildExperimentPatch(experiment.baseCommitSha, worktreePath, untrackedFiles);
    await writeFile(patchPath, patch, 'utf8');

    const check = await execa('git', ['apply', '--check', '--3way', patchPath], {
      cwd: this.options.cwd,
      reject: false
    });
    const applyable = check.exitCode === 0;

    const preview: ExperimentAdoptionPreview = {
      experimentId: experiment.id,
      branchName: experiment.branchName,
      baseCommitSha: experiment.baseCommitSha,
      worktreePath,
      patchPath,
      rollbackBranchName,
      applyable,
      changedFiles,
      untrackedFiles,
      diffStat: diffStatSections.join('\n\n') || '(no diff)'
    };

    if (!options.apply) {
      return preview;
    }

    const rootStatus = await execa('git', ['status', '--short'], {
      cwd: this.options.cwd,
      reject: false
    });
    const blockingStatus = lines(rootStatus.stdout ?? '').filter(
      (line) =>
        line.trim().length > 0 &&
        !line.includes('.h2/')
    );
    if (blockingStatus.length > 0) {
      throw new Error('Main workspace is dirty. Adoption requires a clean working tree.');
    }

    const rollback = await execa('git', ['branch', rollbackBranchName, 'HEAD'], {
      cwd: this.options.cwd,
      reject: false
    });
    if (rollback.exitCode !== 0) {
      throw new Error(`Failed to create rollback branch: ${clampText(rollback.stderr || rollback.stdout, 300)}`);
    }

    const apply = await execa('git', ['apply', '--3way', '--index', patchPath], {
      cwd: this.options.cwd,
      reject: false
    });
    if (apply.exitCode !== 0) {
      throw new Error(`Failed to apply experiment patch: ${clampText(apply.stderr || apply.stdout, 400)}`);
    }

    return {
      ...preview,
      appliedAt: nowIso()
    };
  }

  private async runAuthLogin(): Promise<string> {
    const record = await this.auth.authorize();
    return [
      'OpenAI Codex OAuth configured.',
      `account: ${record.accountId || '(unknown)'}`,
      `expires: ${new Date(record.expiresAt).toISOString()}`
    ].join('\n');
  }

  private async runAuthStatus(): Promise<string> {
    return this.auth.formatStatus();
  }

  private async runAuthLogout(): Promise<string> {
    return this.auth.logout()
      ? 'OpenAI Codex OAuth credentials removed.'
      : 'No OpenAI Codex OAuth credentials were stored.';
  }

  private async runGetModelSettings(): Promise<string> {
    const settings = this.model.getSettings(this.options.sessionId);
    return [
      `model: ${settings.model}`,
      `reasoning: ${settings.reasoningEffort ?? 'off'}`
    ].join('\n');
  }

  private async runSetModel(model: string): Promise<string> {
    const settings = this.model.setModel(this.options.sessionId, model);
    return [
      `model: ${settings.model}`,
      `reasoning: ${settings.reasoningEffort ?? 'off'}`
    ].join('\n');
  }

  private async runSetReasoningEffort(
    effort: 'low' | 'medium' | 'high' | 'off'
  ): Promise<string> {
    const settings = this.model.setReasoningEffort(this.options.sessionId, effort);
    return [
      `model: ${settings.model}`,
      `reasoning: ${settings.reasoningEffort ?? 'off'}`
    ].join('\n');
  }

  private async runGetThinkingMode(): Promise<string> {
    return `thinking ${this.thinkingEnabled ? 'on' : 'off'}`;
  }

  private async runSetThinkingMode(enabled: boolean): Promise<string> {
    this.thinkingEnabled = enabled;
    this.emitChange();
    return `thinking ${enabled ? 'on' : 'off'}`;
  }

  async runExperimentSubagent(experiment: ExperimentRecord): Promise<void> {
    const experimentSessionId = this.experimentManager.getExperimentSessionId(experiment.id);
    this.options.notebook.createSession(experimentSessionId, experiment.worktreePath);
    this.model.setModel(experimentSessionId, DEFAULT_EXPERIMENT_MODEL);
    this.model.setReasoningEffort(experimentSessionId, DEFAULT_EXPERIMENT_REASONING_EFFORT);
    const prompt = [
      `Run a scoped experiment in an isolated copy of the current workspace at ${experiment.worktreePath}.`,
      `Hypothesis: ${experiment.hypothesis}`,
      `Budget: ${experiment.budget} estimated tokens`,
      experiment.context ? `Context: ${experiment.context}` : '',
      `Use log_observation for notable findings and resolve_experiment exactly once when you are done.`,
      `Do not try to spawn another experiment.`
    ]
      .filter(Boolean)
      .join('\n');

    const tools: AgentTools = {
      execCommand: async (input) => {
        const output = await this.runExecCommandAtRoot(experiment.worktreePath, input);
        await this.experimentManager.recordToolUsage(experiment.id, output);
        return output;
      },
      writeStdin: async (input) => {
        const output = await this.runWriteStdinAtRoot(experiment.worktreePath, input);
        await this.experimentManager.recordToolUsage(experiment.id, output);
        return output;
      },
      read: async (filePath, startLine, endLine) => {
        const output = await this.runReadAtRoot(
          experiment.worktreePath,
          filePath,
          startLine,
          endLine
        );
        await this.experimentManager.recordToolUsage(experiment.id, output);
        return output;
      },
      ls: async (filePath, recursive) => {
        const output = await this.runLsAtRoot(experiment.worktreePath, filePath, recursive);
        await this.experimentManager.recordToolUsage(experiment.id, output);
        return output;
      },
      write: async (filePath, content) => {
        const output = await this.runWriteAtRoot(experiment.worktreePath, filePath, content);
        await this.experimentManager.recordToolUsage(experiment.id, output);
        return output;
      },
      edit: async (patchText) => {
        const output = await this.runEditAtRoot(experiment.worktreePath, patchText);
        await this.experimentManager.recordToolUsage(experiment.id, output);
        return output;
      },
      glob: async (pattern) => {
        const output = await this.runGlobAtRoot(experiment.worktreePath, pattern);
        await this.experimentManager.recordToolUsage(experiment.id, JSON.stringify(output));
        return output;
      },
      rg: async (pattern, target) => {
        const output = await this.runRgAtRoot(experiment.worktreePath, pattern, target);
        await this.experimentManager.recordToolUsage(experiment.id, output);
        return output;
      },
      grep: async (pattern, target) => {
        const output = await this.runRgAtRoot(experiment.worktreePath, pattern, target);
        await this.experimentManager.recordToolUsage(experiment.id, output);
        return output;
      },
      spawnExperiment: async () => {
        throw new Error('Nested experiments are not allowed.');
      },
      readExperiment: async (experimentId) => this.experimentManager.read(experimentId),
      waitExperiment: async () => {
        throw new Error('wait_experiment is not available in experiment subagents.');
      },
      searchExperiments: async (query) => this.experimentManager.search(this.options.sessionId, query),
      adoptExperiment: async () => {
        throw new Error('adopt_experiment is not available in experiment subagents.');
      },
      logObservation: async (experimentId, message, tags) =>
        this.experimentManager.logObservation(experimentId, message, tags),
      resolveExperiment: async (input) => this.experimentManager.resolve(input),
      authLogin: async () => {
        throw new Error('Auth tools are not available in experiment subagents.');
      },
      authStatus: async () => {
        throw new Error('Auth tools are not available in experiment subagents.');
      },
      authLogout: async () => {
        throw new Error('Auth tools are not available in experiment subagents.');
      },
      getModelSettings: async () => {
        throw new Error('Model settings are not available in experiment subagents.');
      },
      setModel: async () => {
        throw new Error('Model switching is not available in experiment subagents.');
      },
      setReasoningEffort: async () => {
        throw new Error('Reasoning controls are not available in experiment subagents.');
      },
      getThinkingMode: async () => {
        throw new Error('Thinking mode is not available in experiment subagents.');
      },
      setThinkingMode: async () => {
        throw new Error('Thinking mode is not available in experiment subagents.');
      },
      compact: async () => {
        throw new Error('compact is not available in experiment subagents.');
      }
    };

    await this.model.runTurn(
      experimentSessionId,
      prompt,
      tools,
      async () => undefined,
      undefined,
      undefined,
      false,
      undefined,
      EXPERIMENT_TOOL_DEFINITIONS,
      EXPERIMENT_SUBAGENT_PROMPT,
      undefined,
      undefined,
      true,
      () => this.buildExperimentCompactionStateSnapshot(experiment)
    );
  }

  private handleExperimentResolved(resolution: ExperimentResolution): void {
    const transcriptText = this.formatExperimentLifecycleTool(
      'Experiment resolved',
      {
        experimentId: resolution.id,
        status: resolution.verdict,
        summary: resolution.summary,
        hypothesis: resolution.hypothesis,
        budget: `${resolution.tokensUsed}/${resolution.budget} estimated tokens`,
        budgetBreakdown: `context ${resolution.contextTokensUsed}, tool_output ${resolution.toolOutputTokensUsed}, observations ${resolution.observationTokensUsed}`,
        discovered: resolution.discovered,
        artifacts: resolution.artifacts,
        constraints: resolution.constraints,
        confidenceNote: resolution.confidenceNote,
        next: resolution.promote
          ? `inspect ${resolution.worktreePath} on branch ${resolution.branchName}`
          : resolution.preserved
            ? 'preserved'
            : 'removed'
      }
    );
    this.appendExperimentLifecycleToolNotice(transcriptText);
  }

  private handleExperimentQualitySignal(notification: ExperimentQualityNotification): void {
    const transcriptText = this.formatExperimentLifecycleTool(
      'Experiment low-signal warning',
      {
        experimentId: notification.id,
        status: 'running',
        hypothesis: notification.hypothesis,
        summary: notification.message,
        budget: `${notification.tokensUsed}/${notification.budget} estimated tokens`,
        toolOutput: `${notification.toolOutputTokensUsed}`
      }
    );
    this.appendExperimentLifecycleToolNotice(transcriptText);
  }

  private handleExperimentBudgetExceeded(notification: ExperimentBudgetNotification): void {
    const transcriptText = this.formatExperimentLifecycleTool(
      'Experiment budget exhausted',
      {
        experimentId: notification.id,
        status: 'budget_exhausted',
        hypothesis: notification.hypothesis,
        summary: notification.message,
        budget: `${notification.tokensUsed}/${notification.budget} estimated tokens`,
        budgetBreakdown: `context ${notification.contextTokensUsed}, tool_output ${notification.toolOutputTokensUsed}, observations ${notification.observationTokensUsed}`,
        next: 'extend budget to continue, or leave unresolved and treat as inconclusive'
      }
    );
    this.appendExperimentLifecycleToolNotice(transcriptText);
  }

  private appendExperimentLifecycleToolNotice(transcriptText: string): void {
    if (this.processingTurn) {
      this.appendCompletedToolEvent(transcriptText);
    }
    this.appendTranscript('tool', transcriptText);
    this.appendModelHistory({
      type: 'message',
      role: 'developer',
      content: transcriptText
    });
  }

  private formatExperimentLifecycleTool(
    title: string,
    payload: Record<string, unknown>
  ): string {
    return `@@tool\texperiment_notice\t${title}\n${JSON.stringify(payload, null, 2)}`;
  }

  private resolveRootedPath(root: string, filePath: string): string {
    const resolvedPath = path.resolve(root, filePath);
    const workspaceRoot = `${root}${path.sep}`;

    if (resolvedPath !== root && !resolvedPath.startsWith(workspaceRoot)) {
      throw new Error(`Path escapes workspace: ${filePath}`);
    }

    return resolvedPath;
  }

  private assertStudyDebtAllowsMutation(root: string, resolvedPath: string): void {
    if (root !== this.options.cwd) {
      return;
    }

    const openDebts = this.options.notebook.listOpenStudyDebts(this.options.sessionId);
    if (openDebts.length === 0) {
      return;
    }

    const blockingDebts = openDebts.filter((debt) => {
      if (!debt.affectedPaths || debt.affectedPaths.length === 0) {
        return false;
      }

      return debt.affectedPaths.some((scope) => {
        const resolvedScope = this.resolveRootedPath(this.options.cwd, scope);
        return (
          resolvedPath === resolvedScope ||
          resolvedPath.startsWith(`${resolvedScope}${path.sep}`)
        );
      });
    });

    if (blockingDebts.length === 0) {
      return;
    }

    const debtKey = blockingDebts
      .map((debt) => debt.id)
      .sort()
      .join('|');
    const invalidatedByDebt = new Map(
      blockingDebts.map((debt) => [
        debt.id,
        this.options.notebook.listInvalidatedExperimentsForStudyDebt(debt.id)
      ])
    );
    const linkedInvalidations = Array.from(invalidatedByDebt.values()).flat();
    const repeatedIntercept =
      this.lastStudyDebtIntercept?.turnId === this.activeTurnId &&
      this.lastStudyDebtIntercept.debtKey === debtKey;
    this.lastStudyDebtIntercept = {
      turnId: this.activeTurnId,
      debtKey
    };

    if (repeatedIntercept) {
      throw new Error(
        [
          'An open question still blocks this edit.',
          `questions: ${blockingDebts.map((debt) => debt.id).join(', ')}`,
          ...(linkedInvalidations.length > 0
            ? [
                `invalidated_experiments: ${linkedInvalidations
                  .map((experiment) => experiment.id)
                  .join(', ')}`
              ]
            : []),
          'Resolve the question before editing dependent code.'
        ].join('\n')
      );
    }

    const guidance = blockingDebts
      .map((debt) => {
        const scope =
          debt.affectedPaths && debt.affectedPaths.length > 0
            ? `affected_paths=${debt.affectedPaths.join(', ')}`
            : 'affected_paths=none';
        const study = debt.recommendedStudy ? ` recommended_study=${debt.recommendedStudy}` : '';
        const invalidated = invalidatedByDebt.get(debt.id) ?? [];
        const invalidation =
          invalidated.length > 0
            ? ` linked_invalidated_experiments=${invalidated
                .map((experiment) => `${experiment.id}:${experiment.finalSummary ?? experiment.hypothesis}`)
                .join(' | ')}.`
            : '';
        return `${debt.id} [${debt.kind}] ${debt.summary}; why=${debt.whyItMatters}; ${scope}.${study}${invalidation}`;
      })
      .join('\n');

    throw new Error(
      [
        'An open question blocks this edit.',
        guidance,
        linkedInvalidations.length > 0
          ? 'A linked experiment invalidated the current path. Before editing dependent code, narrow the claim with resolve_question(scope_narrowed), open a new question for a different path, or record a user override.'
          : 'Before editing dependent code, either run a bounded study, resolve the question with static evidence justification, resolve it via explicit scope narrowing, or record a user override with resolve_question.',
        'If this edit depends on additional unresolved risk that is not covered here, open a question for that too before continuing.'
      ].join('\n')
    );
  }

  private assertExperimentAllowsInlineProbe(
    root: string,
    toolName: 'exec_command' | 'write_stdin' | 'read' | 'ls' | 'glob' | 'rg',
    resolvedTargets: string[] = []
  ): void {
    if (root !== this.options.cwd) {
      return;
    }

    const openDebts = this.options.notebook.listOpenStudyDebts(this.options.sessionId);
    if (openDebts.length === 0) {
      return;
    }

    const blockingDebts = openDebts.filter((debt) => {
      const activeExperiments = this.options.notebook.listActiveExperimentsForStudyDebt(debt.id);
      if (activeExperiments.length === 0) {
        return false;
      }

      const evidenceScopes = this.getInlineEvidenceScopes(debt, toolName);
      if (evidenceScopes === null) {
        return false;
      }

      if (evidenceScopes.length === 0) {
        return true;
      }

      if (resolvedTargets.length === 0) {
        return false;
      }

      return evidenceScopes.some((scope) => {
        const resolvedScope = this.resolveRootedPath(this.options.cwd, scope);
        return resolvedTargets.some(
          (resolvedTarget) =>
            resolvedTarget === resolvedScope ||
            resolvedTarget.startsWith(`${resolvedScope}${path.sep}`)
        );
      });
    });

    if (blockingDebts.length === 0) {
      return;
    }

    throw new Error(
      [
        `An active linked experiment already owns this evidence path for ${toolName}.`,
        ...blockingDebts.map((debt) => {
          const activeExperiments = this.options.notebook
            .listActiveExperimentsForStudyDebt(debt.id)
            .map((experiment) => experiment.id)
            .join(', ');
          const evidenceScopes = this.getInlineEvidenceScopes(debt, toolName);
          const scopeLabel =
            evidenceScopes === null
              ? 'none'
              : evidenceScopes.length > 0
                ? evidenceScopes.join(', ')
                : 'all main-workspace evidence';
          return `${debt.id}: ${debt.summary} [active_experiments=${activeExperiments}; evidence_paths=${scopeLabel}]`;
        }),
        'Use wait_experiment or read_experiment before more inline probing on the same question.'
      ].join('\n')
    );
  }

  private consumeInlineProbeBudget(
    root: string,
    toolName: 'exec_command',
    resolvedTargets: string[] = []
  ): string[] {
    if (root !== this.options.cwd) {
      return [];
    }

    const matchingDebts = this.findOpenStudyDebtsForEvidencePath(root, resolvedTargets, {
      requireActiveExperiment: false,
      toolName
    });
    if (matchingDebts.length === 0) {
      return [];
    }

    const exhausted = matchingDebts.filter(
      (debt) => this.options.notebook.getStudyDebtProbeEpisodeCount(debt.id) >= 1
    );
    if (exhausted.length > 0) {
      const runtimeHint = exhausted.some((debt) => debt.kind === 'runtime')
        ? 'For a runtime question, the next move is usually spawn_experiment, narrow_question, or explicit override.'
        : null;
      throw new Error(
        [
          `The inline probe budget for ${toolName} is already exhausted on this question.`,
          ...exhausted.map((debt) => `${debt.id}: ${debt.summary}`),
          'After one bounded inline probe episode on the same question, either resolve_question, spawn_experiment, or explicitly narrow/override the claim before more inline probing.',
          runtimeHint
        ].filter(Boolean).join('\n')
      );
    }

    return matchingDebts.map((debt) => debt.id);
  }

  private assertInlineProbeContinuationAllowed(root: string, session: ExecSession): void {
    if (root !== this.options.cwd) {
      return;
    }

    if (session.probeQuestionIds.length === 0) {
      return;
    }

    const openQuestionIds = new Set(
      this.options.notebook.listOpenStudyDebts(this.options.sessionId).map((debt) => debt.id)
    );
    const missing = session.probeQuestionIds.filter((questionId) => !openQuestionIds.has(questionId));
    if (missing.length === 0) {
      return;
    }

    throw new Error(
      [
        'This running inline probe no longer has an open owning question.',
        `questions: ${missing.join(', ')}`,
        'Resolve, narrow, or reopen the relevant question before continuing the probe.'
      ].join('\n')
    );
  }

  private findOpenStudyDebtsForEvidencePath(
    root: string,
    resolvedTargets: string[],
    options: { requireActiveExperiment: boolean; toolName: 'exec_command' | 'write_stdin' }
  ) {
    const openDebts = this.options.notebook.listOpenStudyDebts(this.options.sessionId);
    return openDebts.filter((debt) => {
      if (options.requireActiveExperiment) {
        const activeExperiments = this.options.notebook.listActiveExperimentsForStudyDebt(debt.id);
        if (activeExperiments.length === 0) {
          return false;
        }
      }

      const evidenceScopes = this.getInlineEvidenceScopes(debt, options.toolName);
      if (evidenceScopes === null) {
        return false;
      }

      if (evidenceScopes.length === 0) {
        return true;
      }

      if (resolvedTargets.length === 0) {
        return false;
      }

      return evidenceScopes.some((scope) => {
        const resolvedScope = this.resolveRootedPath(this.options.cwd, scope);
        return resolvedTargets.some(
          (resolvedTarget) =>
            resolvedTarget === resolvedScope ||
            resolvedTarget.startsWith(`${resolvedScope}${path.sep}`)
        );
      });
    });
  }

  private getInlineEvidenceScopes(
    debt: StudyDebtRecord,
    toolName: 'exec_command' | 'write_stdin' | 'read' | 'ls' | 'glob' | 'rg'
  ): string[] | null {
    void toolName;
    return debt.evidencePaths && debt.evidencePaths.length > 0 ? debt.evidencePaths : null;
  }

  async runCompact(
    goal: string,
    completed: string,
    next: string,
    openRisks?: string,
    currentCommitments?: string,
    importantNonGoals?: string
  ): Promise<{ ok: true; checkpointId: number }> {
    const [gitLog, gitStatus, gitDiffStat] = await Promise.all([
      this.readGitSnapshot(['log', '--oneline', '-5']),
      this.readGitSnapshot(['status', '--short']),
      this.readGitSnapshot(['diff', '--stat'])
    ]);

    const activeExperimentSummaries = this.options.notebook
      .searchExperimentSummaries(this.options.sessionId)
      .filter(
        (experiment) =>
          experiment.status === 'running' || experiment.status === 'budget_exhausted'
      )
      .sort((left, right) => {
        const leftRank = left.status === 'running' ? 0 : 1;
        const rightRank = right.status === 'running' ? 0 : 1;
        return leftRank - rightRank || left.experimentId.localeCompare(right.experimentId);
      });
    const openStudyDebts = this.options.notebook.listOpenStudyDebts(this.options.sessionId);
    const checkpointStudyDebts = openStudyDebts.map((debt) => ({
      id: debt.id,
      kind: debt.kind,
      summary: debt.summary,
      whyItMatters: debt.whyItMatters,
      affectedPaths: debt.affectedPaths ?? [],
      evidencePaths: debt.evidencePaths ?? []
    }));
    const activeExperimentDetails = activeExperimentSummaries.map((summary) => {
      const details = this.options.notebook.getExperimentDetails(summary.experimentId);
      const lastObservation = details?.observations.at(-1)?.message ?? null;
      return {
        experimentId: summary.experimentId,
        status: summary.status,
        hypothesis: summary.hypothesis,
        lastObservation
      };
    });
    const invalidatedExperimentSummaries = Array.from(
      new Map(
        openStudyDebts
          .flatMap((debt) => this.options.notebook.listInvalidatedExperimentsForStudyDebt(debt.id))
          .map((experiment) => [
            experiment.id,
            {
              experimentId: experiment.id,
              hypothesis: experiment.hypothesis,
              status: experiment.status,
              summary: experiment.finalSummary ?? '',
              discovered: experiment.discovered
            }
          ])
      ).values()
    );

    const tailStartHistoryId = this.options.notebook.getTailStartHistoryId(this.options.sessionId, 12);
    const checkpointBlock = this.buildCheckpointBlock({
      goal,
      completed,
      next,
      openRisks,
      currentCommitments,
      importantNonGoals,
      gitLog,
      gitStatus,
      gitDiffStat,
      lastTestStatus: this.lastTestStatus,
      activeExperimentSummaries,
      invalidatedExperimentSummaries,
      openStudyDebts: checkpointStudyDebts,
      activeExperimentDetails
    });

    const checkpoint = this.options.notebook.createSessionCheckpoint({
      sessionId: this.options.sessionId,
      goal,
      completed,
      next,
      openRisks,
      currentCommitments,
      importantNonGoals,
      gitLog,
      gitStatus,
      gitDiffStat,
      lastTestStatus: this.lastTestStatus,
      activeExperimentSummaries,
      invalidatedExperimentSummaries,
      checkpointBlock,
      tailStartHistoryId
    });

    this.emitChange();
    return { ok: true, checkpointId: checkpoint.id };
  }

  private updateLastTestStatus(
    command: string,
    exitCode: number,
    stdout: string,
    stderr: string
  ): void {
    if (!looksLikeTestCommand(command)) {
      return;
    }

    const headline =
      lines(stdout).find((line) => line.trim().length > 0) ??
      lines(stderr).find((line) => line.trim().length > 0) ??
      '(no output)';
    this.lastTestStatus = `${command} | exit ${exitCode} | ${clampText(headline, 200)}`;
  }

  private async readGitSnapshot(args: string[]): Promise<string> {
    const result = await execa('git', args, {
      cwd: this.options.cwd,
      reject: false
    });

    if (result.exitCode === 0) {
      return result.stdout.trim() || '(clean)';
    }

    const errorText = result.stderr.trim() || result.stdout.trim() || '(unavailable)';
    return `git ${args.join(' ')} failed: ${clampText(errorText, 500)}`;
  }

  private buildCheckpointBlock(input: {
    goal: string;
    completed: string;
    next: string;
    openRisks?: string;
    currentCommitments?: string;
    importantNonGoals?: string;
    gitLog: string;
    gitStatus: string;
    gitDiffStat: string;
    lastTestStatus: string | null;
    activeExperimentSummaries: ExperimentSearchResult[];
    invalidatedExperimentSummaries: ExperimentSearchResult[];
    openStudyDebts: Array<{
      id: string;
      kind: string;
      summary: string;
      whyItMatters: string;
      affectedPaths: string[];
      evidencePaths: string[];
    }>;
    activeExperimentDetails: Array<{
      experimentId: string;
      status: string;
      hypothesis: string;
      lastObservation: string | null;
    }>;
  }): string {
    const experimentLines =
      input.activeExperimentDetails.length > 0
        ? input.activeExperimentDetails.map((experiment) =>
            [
              `- ${experiment.experimentId} | ${experiment.status} | ${experiment.hypothesis}`,
              `  last_observation: ${experiment.lastObservation ?? 'none'}`
            ].join('\n')
          )
        : ['- none'];
    const invalidatedExperimentLines =
      input.invalidatedExperimentSummaries.length > 0
        ? input.invalidatedExperimentSummaries.map(
            (experiment) =>
              `- ${experiment.experimentId} | ${experiment.status} | ${experiment.hypothesis}`
          )
        : ['- none'];
    const studyDebtLines =
      input.openStudyDebts.length > 0
        ? input.openStudyDebts.map((debt) =>
            [
              `- ${debt.id} | ${debt.kind} | ${debt.summary}`,
              `  why_it_matters: ${debt.whyItMatters}`,
              `  affected_paths: ${debt.affectedPaths.join(', ') || 'none'}`,
              `  evidence_paths: ${debt.evidencePaths.join(', ') || 'none'}`
            ].join('\n')
          )
        : ['- none'];

    return [
      'Harness checkpoint',
      '',
      'Model-supplied checkpoint:',
      `goal: ${input.goal}`,
      `completed: ${input.completed}`,
      `next: ${input.next}`,
      input.openRisks ? `open_risks: ${input.openRisks}` : 'open_risks: none',
      input.currentCommitments
        ? `current_commitments: ${input.currentCommitments}`
        : 'current_commitments: none',
      input.importantNonGoals
        ? `important_non_goals: ${input.importantNonGoals}`
        : 'important_non_goals: none',
      '',
      'Harness state:',
      'recent_commits:',
      input.gitLog,
      '',
      'working_tree:',
      input.gitStatus,
      '',
      'diff_stat:',
      input.gitDiffStat,
      '',
      `last_test_status: ${input.lastTestStatus ?? 'unknown'}`,
      '',
      'open_questions:',
      ...studyDebtLines,
      '',
      'active_experiments:',
      ...experimentLines,
      '',
      'invalidated_experiments:',
      ...invalidatedExperimentLines
    ].join('\n');
  }

  private async readLines(cwd: string, command: string[]): Promise<string[]> {
    const result = await execa(command[0]!, command.slice(1), {
      cwd,
      reject: false
    });
    if (result.exitCode !== 0) {
      return [];
    }

    return lines(result.stdout)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async readCommandOutput(cwd: string, command: string[]): Promise<string> {
    const result = await execa(command[0]!, command.slice(1), {
      cwd,
      reject: false
    });
    return result.exitCode === 0 ? result.stdout : '';
  }

  private async buildExperimentPatch(
    baseCommitSha: string,
    worktreePath: string,
    untrackedFiles: string[]
  ): Promise<string> {
    const trackedDiff = await this.readCommandOutput(worktreePath, [
      'git',
      'diff',
      '--binary',
      baseCommitSha
    ]);

    const untrackedDiffs: string[] = [];
    for (const relativePath of untrackedFiles) {
      const diff = await execa(
        'git',
        ['diff', '--binary', '--no-index', '--', '/dev/null', relativePath],
        {
          cwd: worktreePath,
          reject: false
        }
      );
      if (diff.stdout.trim()) {
        untrackedDiffs.push(diff.stdout.trimEnd());
      }
    }

    const patch = [trackedDiff.trimEnd(), ...untrackedDiffs].filter(Boolean).join('\n\n');
    return patch ? `${patch}\n` : '';
  }
}

async function migrateLegacyExperimentState(cwd: string, experimentStateDir: string): Promise<void> {
  const legacyStateDir = path.join(cwd, '.harness2');
  const legacyWorktreeDir = path.join(legacyStateDir, 'worktrees');
  if (await directPathExists(experimentStateDir)) {
    return;
  }
  if (!(await directPathExists(legacyWorktreeDir))) {
    return;
  }

  await mkdir(path.dirname(experimentStateDir), { recursive: true });
  await rename(legacyWorktreeDir, experimentStateDir);
}

async function directPathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function renderSessionExport(input: {
  session: { id: string; cwd: string; startedAt: string; lastActiveAt: string };
  transcript: Array<{ id: number; role: TranscriptRole; text: string; createdAt: string }>;
  experiments: ExperimentRecord[];
  studyDebts: Array<{
    id: string;
    status: string;
    kind: string;
    summary: string;
    whyItMatters: string;
    affectedPaths: string[] | null;
    evidencePaths: string[] | null;
    recommendedStudy: string | null;
    resolution: string | null;
    resolutionNote: string | null;
  }>;
}): string {
  const experimentSection =
    input.experiments.length > 0
      ? input.experiments
          .map((experiment) =>
            [
              `- ${experiment.id}`,
              `  - status: ${experiment.status}`,
              `  - hypothesis: ${experiment.hypothesis}`,
              experiment.finalSummary ? `  - summary: ${experiment.finalSummary}` : null,
              experiment.discovered.length > 0
                ? `  - discovered: ${experiment.discovered.join(' | ')}`
                : null
            ]
              .filter((line): line is string => Boolean(line))
              .join('\n')
          )
          .join('\n')
      : '- none';

  const debtSection =
    input.studyDebts.length > 0
      ? input.studyDebts
          .map((debt) =>
            [
              `- ${debt.id}`,
              `  - status: ${debt.status}`,
              `  - kind: ${debt.kind}`,
              `  - summary: ${debt.summary}`,
              `  - why: ${debt.whyItMatters}`,
              debt.affectedPaths && debt.affectedPaths.length > 0
                ? `  - affectedPaths: ${debt.affectedPaths.join(', ')}`
                : null,
              debt.evidencePaths && debt.evidencePaths.length > 0
                ? `  - evidencePaths: ${debt.evidencePaths.join(', ')}`
                : null,
              debt.recommendedStudy ? `  - recommendedStudy: ${debt.recommendedStudy}` : null,
              debt.resolution ? `  - resolution: ${debt.resolution}` : null,
              debt.resolutionNote ? `  - resolutionNote: ${debt.resolutionNote}` : null
            ]
              .filter((line): line is string => Boolean(line))
              .join('\n')
          )
          .join('\n')
      : '- none';

  const transcriptSection = input.transcript
    .map(
      (entry) =>
        `## ${entry.id} ${entry.role} ${entry.createdAt}\n\n${entry.text.trim() || '(empty)'}`
    )
    .join('\n\n');

  return [
    `# Session Export ${input.session.id}`,
    '',
    '## Metadata',
    `- sessionId: ${input.session.id}`,
    `- cwd: ${input.session.cwd}`,
    `- startedAt: ${input.session.startedAt}`,
    `- lastActiveAt: ${input.session.lastActiveAt}`,
    '',
    '## Experiments',
    experimentSection,
    '',
    '## Study Debt',
    debtSection,
    '',
    '## Transcript',
    transcriptSection
  ].join('\n');
}

function formatCommandResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string
): string {
  const sections = [`$ ${command}`, `exit: ${exitCode}`];

  if (stdout.trim()) {
    sections.push(`stdout:\n${clampText(stdout, 12000)}`);
  }

  if (stderr.trim()) {
    sections.push(`stderr:\n${clampText(stderr, 12000)}`);
  }

  if (!stdout.trim() && !stderr.trim()) {
    sections.push('(no output)');
  }

  return sections.join('\n\n');
}

function normalizeExecYieldTime(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_EXEC_YIELD_MS;
  }

  return Math.max(50, Math.floor(value as number));
}

function normalizeExecOutputChars(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_EXEC_MAX_OUTPUT_CHARS;
  }

  return Math.max(256, Math.floor(value as number));
}

function appendCappedText(
  existing: string,
  chunk: string,
  maxChars: number
): { text: string; droppedChars: number } {
  const combined = existing + chunk;
  if (combined.length <= maxChars) {
    return { text: combined, droppedChars: 0 };
  }

  const droppedChars = combined.length - maxChars;
  return {
    text: combined.slice(droppedChars),
    droppedChars
  };
}

function appendCappedTail(existing: string, chunk: string, maxChars: number): string {
  const combined = existing + chunk;
  return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
}

function drainExecOutput(
  session: ExecSession,
  stream: 'stdout' | 'stderr',
  maxChars: number
): string {
  const bufferKey = stream === 'stdout' ? 'pendingStdout' : 'pendingStderr';
  const droppedKey = stream === 'stdout' ? 'droppedStdoutChars' : 'droppedStderrChars';
  let available = session[bufferKey];

  if (session[droppedKey] > 0) {
    const note = `[older ${stream} truncated: ${session[droppedKey]} chars]\n`;
    available = note + available;
    session[droppedKey] = 0;
  }

  if (available.length <= maxChars) {
    session[bufferKey] = '';
    return available;
  }

  session[bufferKey] = available.slice(maxChars);
  return available.slice(0, maxChars);
}

function relativeToWorkspace(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath) || '.';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function normalizeRgTargets(root: string, target: string | string[]): Promise<string[]> {
  if (Array.isArray(target)) {
    const normalized = target
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return normalized.length > 0 ? normalized : ['.'];
  }

  const trimmed = target.trim();
  if (!trimmed) {
    return ['.'];
  }

  if (!(await rootedPathExists(root, trimmed))) {
    const splitTargets = trimmed
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (splitTargets.length > 1) {
      return splitTargets;
    }
  }

  return [trimmed];
}

async function rootedPathExists(root: string, relativePath: string): Promise<boolean> {
  try {
    await access(path.resolve(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

function normalizeReadStartLine(startLine?: number): number {
  if (!Number.isFinite(startLine) || !startLine) {
    return 1;
  }

  return Math.max(1, Math.floor(startLine));
}

function normalizeReadEndLine(startLine: number, endLine: number | undefined, totalLines: number): number {
  const maxLine = Math.max(1, totalLines);
  if (!Number.isFinite(endLine) || !endLine) {
    return Math.min(maxLine, startLine + 99);
  }

  return Math.min(maxLine, Math.max(startLine, Math.floor(endLine)));
}

function validateCreatePlanInput(input: CreatePlanInput): void {
  if (input.goal.trim().length === 0) {
    throw new Error('create_plan requires a non-empty goal.');
  }

  if (!input.steps.some((step) => step.trim().length > 0)) {
    throw new Error('create_plan requires at least one concrete step.');
  }

  if (input.planMarkdown.trim().length === 0) {
    throw new Error('create_plan requires non-empty planMarkdown.');
  }
}

function validateAskUserInput(input: AskUserInput): void {
  if (input.question.trim().length === 0) {
    throw new Error('ask_user requires a non-empty question.');
  }

  if (input.kind === 'approval' && input.responseKind !== 'yes_no') {
    throw new Error('ask_user approval requests must use responseKind=yes_no.');
  }

  if (input.responseKind === 'yes_no') {
    if (!input.recommendedResponse) {
      throw new Error('ask_user yes_no requests require recommendedResponse.');
    }
    if (!input.reason || input.reason.trim().length === 0) {
      throw new Error('ask_user yes_no requests require a reason.');
    }
    return;
  }

  if (input.responseKind === 'single_choice') {
    if (!input.options || input.options.length < 2 || input.options.length > 4) {
      throw new Error('ask_user single_choice requests require 2 to 4 options.');
    }
    const optionIds = input.options.map((option) => option.id.trim());
    if (
      optionIds.some((id) => id.length === 0) ||
      input.options.some(
        (option) => option.label.trim().length === 0 || option.description.trim().length === 0
      )
    ) {
      throw new Error('ask_user single_choice options must have non-empty id, label, and description.');
    }
    if (new Set(optionIds).size !== optionIds.length) {
      throw new Error('ask_user single_choice option ids must be unique.');
    }
    if (!input.recommendedOptionId || !optionIds.includes(input.recommendedOptionId)) {
      throw new Error('ask_user single_choice requests require recommendedOptionId to match one option.');
    }
    if (!input.reason || input.reason.trim().length === 0) {
      throw new Error('ask_user single_choice requests require a reason.');
    }
  }
}

function parseYesNoAnswer(input: string): 'yes' | 'no' | null {
  const normalized = input.trim().toLowerCase();
  if (/^(yes|y|approve|approved|go ahead|proceed)\b/.test(normalized)) {
    return 'yes';
  }
  if (/^(no|n|reject|decline|do not proceed|don't proceed)\b/.test(normalized)) {
    return 'no';
  }
  return null;
}

function parseSingleChoiceAnswer(
  input: string,
  options: Array<{ id: string; label: string }>
): { id: string; label: string } | null {
  const normalized = input.trim().toLowerCase();
  for (const option of options) {
    const id = option.id.toLowerCase();
    if (new RegExp(`(^|\\b)${escapeRegExp(id)}(\\b|$)`).test(normalized)) {
      return option;
    }
  }

  for (const option of options) {
    const label = option.label.trim().toLowerCase();
    if (label && normalized.includes(label)) {
      return option;
    }
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateStudyDebtPaths(
  cwd: string,
  affectedPaths: string[] | undefined,
  evidencePaths: string[] | undefined
): void {
  const normalizedAffectedPaths =
    affectedPaths?.map((scope) => scope.trim()).filter(Boolean) ?? [];
  if (normalizedAffectedPaths.length === 0) {
    throw new Error('affectedPaths is required and must contain at least one specific path.');
  }

  for (const [label, paths] of [
    ['affectedPaths', affectedPaths],
    ['evidencePaths', evidencePaths]
  ] as const) {
    if (!paths) {
      continue;
    }
    const normalizedPaths = paths.map((scope) => scope.trim()).filter(Boolean);
    if (normalizedPaths.length === 0) {
      throw new Error(`${label} must contain at least one specific path.`);
    }
    for (const scope of paths) {
      const trimmed = scope.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed === '.' || trimmed === './' || trimmed === '*' || trimmed === '**') {
        throw new Error(`${label} cannot target the repo root or wildcard root scopes.`);
      }
      const resolved = path.resolve(cwd, trimmed);
      if (resolved === cwd) {
        throw new Error(`${label} cannot target the repo root; use more specific paths.`);
      }
    }
  }
}

function validateTodoItems(items: UpdateTodosInput['items']): void {
  if (items.length > 8) {
    throw new Error('update_todos allows at most 8 items.');
  }

  const ids = items.map((item) => item.id.trim());
  if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) {
    throw new Error('Todo ids must be non-empty and unique.');
  }

  const inProgressCount = items.filter((item) => item.status === 'in_progress').length;
  if (inProgressCount > 1) {
    throw new Error('update_todos allows at most one in_progress item.');
  }
}

function looksLikeTestCommand(command: string): boolean {
  return /\b(test|vitest|jest|mocha|ava|tap|pytest|rspec|ctest)\b/.test(command);
}
