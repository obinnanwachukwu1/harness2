import { glob, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { execa, execaCommand } from 'execa';

import { OpenAICodexAuth } from '../auth/openai-codex.js';
import { ExperimentManager } from '../experiments/experiment-manager.js';
import { clampText, createSessionId, lines, nowIso } from '../lib/utils.js';
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
  ExperimentRecord,
  ExperimentResolution,
  ExperimentSearchResult,
  ExperimentWaitResult,
  ModelHistoryItem,
  SpawnExperimentInput,
  TranscriptRole
} from '../types.js';
import { PrototypeRunner } from './prototype-runner.js';

interface OpenEngineOptions {
  cwd: string;
  sessionId?: string;
}

export class HeadlessEngine {
  static async open(options: OpenEngineOptions): Promise<HeadlessEngine> {
    const sessionId = options.sessionId ?? createSessionId();
    const stateDir = path.join(options.cwd, '.h2');
    const experimentStateDir = path.join(options.cwd, '.harness2');
    const dbPath = path.join(stateDir, 'notebook.sqlite');
    const notebook = new Notebook(dbPath);

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
      notebook,
      runner: new PrototypeRunner()
    });
  }

  private readonly events = new EventEmitter();
  private readonly experimentManager: ExperimentManager;
  private readonly auth: OpenAICodexAuth;
  private readonly model: CodexModelClient;
  private readonly tools: AgentTools;
  private processingTurn = false;
  private statusText = 'idle';
  private liveAssistantText: string | null = null;
  private turnQueue: Promise<void> = Promise.resolve();
  private lastTestStatus: string | null = null;

  private constructor(
    private readonly options: {
      cwd: string;
      sessionId: string;
      stateDir: string;
      experimentStateDir: string;
      notebook: Notebook;
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
    this.auth = new OpenAICodexAuth(options.notebook);
    this.model = new CodexModelClient(options.notebook, this.auth);

    this.tools = {
      bash: (command) => this.runBash(command),
      read: (filePath, startLine, endLine) => this.runRead(filePath, startLine, endLine),
      write: (filePath, content) => this.runWrite(filePath, content),
      edit: (filePath, findText, replaceText) => this.runEdit(filePath, findText, replaceText),
      glob: (pattern) => this.runGlob(pattern),
      grep: (pattern, target) => this.runGrep(pattern, target),
      spawnExperiment: (input) => this.spawnExperiment(input),
      extendExperimentBudget: (experimentId, additionalTokens) =>
        this.extendExperimentBudget(experimentId, additionalTokens),
      readExperiment: (experimentId) => this.readExperiment(experimentId),
      waitExperiment: (experimentId, timeoutMs) => this.waitExperiment(experimentId, timeoutMs),
      searchExperiments: (query) => this.searchExperiments(query),
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
      setReasoningEffort: (effort) => this.runSetReasoningEffort(effort)
    };
  }

  get snapshot(): EngineSnapshot {
    const contextWindow = this.model.getContextWindowUsage(this.options.sessionId);
    return this.options.notebook.getSnapshot(
      this.options.sessionId,
      this.processingTurn,
      this.statusText,
      contextWindow.usedTokens,
      contextWindow.totalTokens,
      this.liveAssistantText
    );
  }

  subscribe(listener: () => void): () => void {
    this.events.on('change', listener);
    return () => {
      this.events.off('change', listener);
    };
  }

  submit(
    input: string,
    options: {
      onTranscriptEntry?: (role: TranscriptRole, text: string) => Promise<void> | void;
      onAssistantStream?: (text: string) => Promise<void> | void;
    } = {}
  ): Promise<void> {
    const work = this.turnQueue.then(async () => {
      const trimmed = input.trim();
      if (!trimmed) {
        return;
      }

      this.processingTurn = true;
      this.statusText = 'running turn';
      this.liveAssistantText = null;
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
            if (role === 'assistant') {
              this.liveAssistantText = null;
            }
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
                if (role === 'assistant') {
                  this.liveAssistantText = null;
                }
                this.appendTranscript(role, text);
                await options.onTranscriptEntry?.(role, text);
              },
              async (text) => {
                this.liveAssistantText = text;
                this.emitChange();
                await options.onAssistantStream?.(text);
              }
            );
          }
        });
        this.statusText = 'idle';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
        this.liveAssistantText = null;
        this.emitChange();
      }
    });

    this.turnQueue = work.catch(() => undefined);
    return work;
  }

  async dispose(): Promise<void> {
    await this.experimentManager.dispose();
    this.options.notebook.close();
  }

  private appendTranscript(role: TranscriptRole, text: string): void {
    this.options.notebook.appendTranscript(this.options.sessionId, role, text);
    this.emitChange();
  }

  private appendModelHistory(item: ModelHistoryItem): void {
    this.options.notebook.appendModelHistoryItem(this.options.sessionId, item);
  }

  private appendLocalReplayOutput(role: TranscriptRole, text: string): void {
    if (role === 'assistant' || role === 'system') {
      this.appendModelHistory({
        type: 'message',
        role,
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

  private async runBash(command: string): Promise<string> {
    return this.runBashAtRoot(this.options.cwd, command);
  }

  private async runRead(filePath: string, startLine?: number, endLine?: number): Promise<string> {
    return this.runReadAtRoot(this.options.cwd, filePath, startLine, endLine);
  }

  private async runWrite(filePath: string, content: string): Promise<string> {
    return this.runWriteAtRoot(this.options.cwd, filePath, content);
  }

  private async runEdit(filePath: string, findText: string, replaceText: string): Promise<string> {
    return this.runEditAtRoot(this.options.cwd, filePath, findText, replaceText);
  }

  private async runGlob(patternText: string): Promise<string[]> {
    return this.runGlobAtRoot(this.options.cwd, patternText);
  }

  private async runGrep(patternText: string, target = '.'): Promise<string> {
    return this.runGrepAtRoot(this.options.cwd, patternText, target);
  }

  private async runBashAtRoot(root: string, command: string): Promise<string> {
    const result = await execaCommand(command, {
      cwd: root,
      shell: true,
      reject: false
    });

    const output = formatCommandResult(command, result.exitCode ?? 1, result.stdout, result.stderr);
    if (root === this.options.cwd) {
      this.updateLastTestStatus(command, result.exitCode ?? 1, result.stdout, result.stderr);
    }
    return output;
  }

  private async runReadAtRoot(
    root: string,
    filePath: string,
    startLine?: number,
    endLine?: number
  ): Promise<string> {
    const resolvedPath = this.resolveRootedPath(root, filePath);
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

  private async runWriteAtRoot(root: string, filePath: string, content: string): Promise<string> {
    const resolvedPath = this.resolveRootedPath(root, filePath);
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, content, 'utf8');
    return `Wrote ${content.length} chars to ${relativeToWorkspace(root, resolvedPath)}.`;
  }

  private async runEditAtRoot(
    root: string,
    filePath: string,
    findText: string,
    replaceText: string
  ): Promise<string> {
    const resolvedPath = this.resolveRootedPath(root, filePath);
    const current = await readFile(resolvedPath, 'utf8');

    if (!current.includes(findText)) {
      throw new Error(`Could not find target text in ${filePath}.`);
    }

    const next = current.replace(findText, replaceText);
    await writeFile(resolvedPath, next, 'utf8');
    return `Edited ${relativeToWorkspace(root, resolvedPath)}.`;
  }

  private async runGlobAtRoot(root: string, patternText: string): Promise<string[]> {
    const matches: string[] = [];
    for await (const entry of glob(patternText, { cwd: root })) {
      matches.push(entry);
    }

    return matches
      .filter((entry) => !entry.startsWith('.git/') && !entry.startsWith('.h2/') && !entry.startsWith('.harness2/'))
      .sort();
  }

  private async runGrepAtRoot(root: string, patternText: string, target = '.'): Promise<string> {
    try {
      const result = await execa(
        'rg',
        ['-n', '--hidden', '--glob', '!.git', '--glob', '!.h2', '--glob', '!.harness2', patternText, target],
        {
          cwd: root,
          reject: false
        }
      );

      if (result.exitCode === 1 && !result.stderr.trim()) {
        return `No matches for ${patternText}.`;
      }

      return formatCommandResult(
        `rg -n --hidden ${patternText} ${target}`,
        result.exitCode ?? 1,
        result.stdout,
        result.stderr
      );
    } catch (error) {
      const result = await execa('grep', ['-R', '-n', patternText, target], {
        cwd: root,
        reject: false
      });

      return formatCommandResult(
        `grep -R -n ${patternText} ${target}`,
        result.exitCode ?? 1,
        result.stdout,
        result.stderr
      );
    }
  }

  private async spawnExperiment(
    input: Omit<SpawnExperimentInput, 'sessionId'>
  ): Promise<ExperimentRecord> {
    return this.experimentManager.spawn({
      ...input,
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

  private async searchExperiments(query?: string): Promise<ExperimentSearchResult[]> {
    return this.experimentManager.search(this.options.sessionId, query);
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
        !line.includes('.h2/') &&
        !line.includes('.harness2/')
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

  private async runExperimentSubagent(experiment: ExperimentRecord): Promise<void> {
    const experimentSessionId = this.experimentManager.getExperimentSessionId(experiment.id);
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
      bash: async (command) => {
        const output = await this.runBashAtRoot(experiment.worktreePath, command);
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
      write: async (filePath, content) => {
        const output = await this.runWriteAtRoot(experiment.worktreePath, filePath, content);
        await this.experimentManager.recordToolUsage(experiment.id, output);
        return output;
      },
      edit: async (filePath, findText, replaceText) => {
        const output = await this.runEditAtRoot(
          experiment.worktreePath,
          filePath,
          findText,
          replaceText
        );
        await this.experimentManager.recordToolUsage(experiment.id, output);
        return output;
      },
      glob: async (pattern) => {
        const output = await this.runGlobAtRoot(experiment.worktreePath, pattern);
        await this.experimentManager.recordToolUsage(experiment.id, JSON.stringify(output));
        return output;
      },
      grep: async (pattern, target) => {
        const output = await this.runGrepAtRoot(experiment.worktreePath, pattern, target);
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
      EXPERIMENT_TOOL_DEFINITIONS,
      EXPERIMENT_SUBAGENT_PROMPT
    );
  }

  private handleExperimentResolved(resolution: ExperimentResolution): void {
    const lines = [
      `Experiment resolved`,
      `id: ${resolution.id}`,
      `verdict: ${resolution.verdict}`,
      `summary: ${resolution.summary}`,
      `budget: ${resolution.tokensUsed}/${resolution.budget} estimated tokens`,
      `budget_breakdown: context ${resolution.contextTokensUsed}, tool_output ${resolution.toolOutputTokensUsed}, observations ${resolution.observationTokensUsed}`,
      resolution.discovered.length > 0
        ? `discovered: ${resolution.discovered.join(' | ')}`
        : null,
      resolution.artifacts.length > 0
        ? `artifacts: ${resolution.artifacts.join(' | ')}`
        : null,
      resolution.constraints.length > 0
        ? `constraints: ${resolution.constraints.join(' | ')}`
        : null,
      resolution.confidenceNote
        ? `confidence: ${resolution.confidenceNote}`
        : null,
      resolution.promote
        ? `promote: inspect ${resolution.worktreePath} on branch ${resolution.branchName}`
        : `cleanup: ${resolution.preserved ? 'preserved' : 'removed'}`
    ].filter((line): line is string => Boolean(line));

    const message = lines.join('\n');
    this.appendTranscript('assistant', message);
    this.appendModelHistory({
      type: 'message',
      role: 'assistant',
      content: message
    });
  }

  private handleExperimentQualitySignal(notification: ExperimentQualityNotification): void {
    const message = [
      'Experiment low-signal warning',
      `id: ${notification.id}`,
      `hypothesis: ${notification.hypothesis}`,
      `message: ${notification.message}`,
      `budget: ${notification.tokensUsed}/${notification.budget} estimated tokens`,
      `tool_output: ${notification.toolOutputTokensUsed}`
    ].join('\n');

    this.appendTranscript('assistant', message);
    this.appendModelHistory({
      type: 'message',
      role: 'assistant',
      content: message
    });
  }

  private handleExperimentBudgetExceeded(notification: ExperimentBudgetNotification): void {
    const message = [
      'Experiment budget exhausted',
      `id: ${notification.id}`,
      `hypothesis: ${notification.hypothesis}`,
      `message: ${notification.message}`,
      `budget: ${notification.tokensUsed}/${notification.budget} estimated tokens`,
      `budget_breakdown: context ${notification.contextTokensUsed}, tool_output ${notification.toolOutputTokensUsed}, observations ${notification.observationTokensUsed}`,
      `next: extend budget to continue, or leave unresolved and treat as inconclusive`
    ].join('\n');

    this.appendTranscript('assistant', message);
    this.appendModelHistory({
      type: 'message',
      role: 'assistant',
      content: message
    });
  }

  private resolveRootedPath(root: string, filePath: string): string {
    const resolvedPath = path.resolve(root, filePath);
    const workspaceRoot = `${root}${path.sep}`;

    if (resolvedPath !== root && !resolvedPath.startsWith(workspaceRoot)) {
      throw new Error(`Path escapes workspace: ${filePath}`);
    }

    return resolvedPath;
  }

  private async runCompact(
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
      activeExperimentSummaries
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
  }): string {
    const experimentLines =
      input.activeExperimentSummaries.length > 0
        ? input.activeExperimentSummaries.map(
            (experiment) =>
              `- ${experiment.experimentId} | ${experiment.status} | ${experiment.hypothesis}`
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

function relativeToWorkspace(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath) || '.';
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
