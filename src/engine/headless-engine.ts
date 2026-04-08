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
import { CodexModelClient, EXPERIMENT_TOOL_DEFINITIONS } from '../model/codex-client.js';
import { EXPERIMENT_SUBAGENT_PROMPT } from '../model/codex-prompt.js';
import { Notebook } from '../storage/notebook.js';
import type {
  AgentRunner,
  AgentTools,
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
  LiveTurnEvent,
  ModelHistoryItem,
  SessionExportResult,
  SpawnExperimentInput,
  StudyDebtKind,
  StudyDebtResolution,
  TranscriptRole,
  WriteStdinInput,
  WriteStdinResult
} from '../types.js';
import { executeEditPatch } from './edit-patch.js';
import { PrototypeRunner } from './prototype-runner.js';

interface OpenEngineOptions {
  cwd: string;
  sessionId?: string;
  revealExportsInFinder?: boolean;
}

const DEFAULT_EXPERIMENT_MODEL = process.env.H2_EXPERIMENT_MODEL ?? 'gpt-5.4-mini';
const DEFAULT_EXPERIMENT_REASONING_EFFORT =
  (process.env.H2_EXPERIMENT_REASONING_EFFORT as 'low' | 'medium' | 'high' | 'off' | undefined) ??
  'high';
const DEFAULT_COMMAND_SHELL = process.env.H2_COMMAND_SHELL ?? process.env.SHELL ?? 'zsh';
const DEFAULT_EXEC_YIELD_MS = 1_000;
const DEFAULT_EXEC_MAX_OUTPUT_CHARS = 12_000;
const MAX_EXEC_PENDING_OUTPUT_CHARS = 200_000;
const MAX_EXEC_CAPTURED_OUTPUT_CHARS = 64_000;

interface ExecSession {
  id: number;
  command: string;
  cwd: string;
  root: string;
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
}

export class HeadlessEngine {
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
      notebook.touchSession(sessionId);
    } else {
      notebook.createSession(sessionId, options.cwd);
    }

    return new HeadlessEngine({
      cwd: options.cwd,
      sessionId,
      stateDir,
      experimentStateDir,
      revealExportsInFinder: options.revealExportsInFinder ?? true,
      notebook,
      authNotebook,
      runner: new PrototypeRunner()
    });
  }

  private readonly events = new EventEmitter();
  private readonly experimentManager: ExperimentManager;
  private readonly auth: OpenAICodexAuth;
  private readonly model: CodexModelClient;
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

  private constructor(
    private readonly options: {
      cwd: string;
      sessionId: string;
      stateDir: string;
      experimentStateDir: string;
      revealExportsInFinder: boolean;
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
    this.model = new CodexModelClient(options.notebook, this.auth);

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
      searchExperiments: (query) => this.searchExperiments(query),
      openStudyDebt: (input) => this.openStudyDebt(input),
      resolveStudyDebt: (input) => this.resolveStudyDebt(input),
      exportSession: (sessionId) => this.exportSession(sessionId),
      clearExperimentJournal: (force) => this.clearExperimentJournal(force),
      adoptExperiment: (experimentId, adoptionOptions) =>
        this.adoptExperiment(experimentId, adoptionOptions),
      resolveExperiment: async (input) => this.experimentManager.resolve(input),
      compact: (goal, completed, next, openRisks) =>
        this.runCompact(goal, completed, next, openRisks),
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
      contextWindow.totalTokens,
      contextWindow.standardRateTokens,
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

  get modelClient(): CodexModelClient {
    return this.model;
  }

  get experiments(): ExperimentManager {
    return this.experimentManager;
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
      const trimmed = input.trim();
      if (!trimmed) {
        return;
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
        await this.options.runner.runTurn(trimmed, {
          tools: this.tools,
          emit: async (role, text) => {
            this.resetLiveStreamsForTranscriptEntry(role, text);
            this.appendTranscript(role, text);
            this.appendLocalReplayOutput(role, text);
            await options.onTranscriptEntry?.(role, text);
          },
          runModel: async (input) => {
            await this.model.runTurn(
              this.options.sessionId,
              input,
              this.tools,
              async (role, text) => {
                this.resetLiveStreamsForTranscriptEntry(role, text);
                this.appendTranscript(role, text);
                await options.onTranscriptEntry?.(role, text);
              },
              async (text) => {
                this.appendLiveTextEvent('assistant', text);
                await options.onAssistantStream?.(text);
              },
              async (text) => {
                this.appendLiveTextEvent('thinking', text);
                await options.onReasoningSummaryStream?.(text);
              },
              this.thinkingEnabled,
              undefined,
              undefined,
              async (toolCall) => {
                this.startLiveToolCall(toolCall);
              },
              async (toolCallId, transcriptText) => {
                this.finishLiveToolCall(toolCallId, transcriptText);
              }
            );
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
    await this.disposeExecSessions();
    await this.experimentManager.dispose();
    this.options.notebook.close();
    this.options.authNotebook.close();
  }

  private appendTranscript(role: TranscriptRole, text: string): void {
    this.options.notebook.appendTranscript(this.options.sessionId, role, text);
    this.emitChange();
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

    const session = this.startExecSession(root, cwd, command);
    await this.waitForExecSession(session, normalizeExecYieldTime(input.yieldTimeMs));

    const result = this.collectExecCommandResult(session, command, cwd, input.maxOutputChars);
    return JSON.stringify(result, null, 2);
  }

  private async runWriteStdinAtRoot(root: string, input: WriteStdinInput): Promise<string> {
    const session = this.execSessions.get(input.processId);
    if (!session || session.root !== root) {
      throw new Error(`Unknown process: ${input.processId}`);
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

  private startExecSession(root: string, cwd: string, command: string): ExecSession {
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
      resolveWaitForExit
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
  }

  private async waitForExecSession(session: ExecSession, yieldTimeMs: number): Promise<void> {
    if (!session.running) {
      return;
    }

    await Promise.race([session.waitForExit, delay(yieldTimeMs)]);
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

    return this.experimentManager.spawn({
      ...input,
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
    query?: string
  ): Promise<ExperimentSearchResult[] | ExperimentSearchGuardrail> {
    const openDebts = this.options.notebook.listOpenStudyDebts(this.options.sessionId);
    if (openDebts.length === 0) {
      return {
        ok: false,
        guardrail:
          'search_experiments is subordinate to the current task. Open the live question first, or explicitly say why no question is needed before searching prior experiments.',
        suggestedNext: [
          'Name the implementation-changing uncertainty.',
          'Open the question if dependent edits rely on it.',
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
    affectedPaths?: string[];
    recommendedStudy?: string;
  }): Promise<{
    questionId: string;
    status: 'open';
    summary: string;
    kind: StudyDebtKind;
  }> {
    const record = this.options.notebook.openStudyDebt({
      sessionId: this.options.sessionId,
      summary: input.summary,
      whyItMatters: input.whyItMatters,
      kind: input.kind,
      affectedPaths: input.affectedPaths,
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
      `Run a scoped experiment in the isolated worktree at ${experiment.worktreePath}.`,
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
      EXPERIMENT_TOOL_DEFINITIONS,
      EXPERIMENT_SUBAGENT_PROMPT
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
        return true;
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
            : 'affected_paths=all main-workspace edits';
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
    toolName: 'exec_command' | 'read' | 'ls' | 'glob' | 'rg',
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

      if (!debt.affectedPaths || debt.affectedPaths.length === 0) {
        return true;
      }

      if (resolvedTargets.length === 0) {
        return false;
      }

      return debt.affectedPaths.some((scope) => {
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
          const scope =
            debt.affectedPaths && debt.affectedPaths.length > 0
              ? debt.affectedPaths.join(', ')
              : 'all main-workspace evidence';
          return `${debt.id}: ${debt.summary} [active_experiments=${activeExperiments}; affected_paths=${scope}]`;
        }),
        'Use wait_experiment or read_experiment before more inline probing on the same question.'
      ].join('\n')
    );
  }

  async runCompact(
    goal: string,
    completed: string,
    next: string,
    openRisks?: string
  ): Promise<{ ok: true; checkpointId: number }> {
    const [gitLog, gitStatus, gitDiffStat] = await Promise.all([
      this.readGitSnapshot(['log', '--oneline', '-5']),
      this.readGitSnapshot(['status', '--short']),
      this.readGitSnapshot(['diff', '--stat'])
    ]);

    const activeExperimentSummaries = this.options.notebook
      .searchExperimentSummaries(this.options.sessionId)
      .filter((experiment) => experiment.status === 'running');
    const openStudyDebts = this.options.notebook.listOpenStudyDebts(this.options.sessionId);

    const tailStartHistoryId = this.options.notebook.getTailStartHistoryId(this.options.sessionId, 12);
    const checkpointBlock = this.buildCheckpointBlock({
      goal,
      completed,
      next,
      openRisks,
      gitLog,
      gitStatus,
      gitDiffStat,
      lastTestStatus: this.lastTestStatus,
      activeExperimentSummaries,
      openStudyDebts
    });

    const checkpoint = this.options.notebook.createSessionCheckpoint({
      sessionId: this.options.sessionId,
      goal,
      completed,
      next,
      openRisks,
      gitLog,
      gitStatus,
      gitDiffStat,
      lastTestStatus: this.lastTestStatus,
      activeExperimentSummaries,
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
    gitLog: string;
    gitStatus: string;
    gitDiffStat: string;
    lastTestStatus: string | null;
    activeExperimentSummaries: ExperimentSearchResult[];
    openStudyDebts: Array<{
      id: string;
      kind: string;
      summary: string;
    }>;
  }): string {
    const experimentLines =
      input.activeExperimentSummaries.length > 0
        ? input.activeExperimentSummaries.map(
            (experiment) =>
              `- ${experiment.experimentId} | ${experiment.status} | ${experiment.hypothesis}`
          )
        : ['- none'];
    const studyDebtLines =
      input.openStudyDebts.length > 0
        ? input.openStudyDebts.map((debt) => `- ${debt.id} | ${debt.kind} | ${debt.summary}`)
        : ['- none'];

    return [
      'Harness checkpoint',
      '',
      'Model-supplied checkpoint:',
      `goal: ${input.goal}`,
      `completed: ${input.completed}`,
      `next: ${input.next}`,
      input.openRisks ? `open_risks: ${input.openRisks}` : 'open_risks: none',
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
      ...experimentLines
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

function looksLikeTestCommand(command: string): boolean {
  return /\b(test|vitest|jest|mocha|ava|tap|pytest|rspec|ctest)\b/.test(command);
}
