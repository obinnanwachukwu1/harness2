import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';

import { clampText, createExperimentId, estimateTokens, lines, nowIso } from '../lib/utils.js';
import { Notebook } from '../storage/notebook.js';
import type {
  ExperimentDetails,
  ExperimentObservationTag,
  ExperimentRecord,
  ExperimentResolution,
  ExperimentSearchResult,
  ExperimentWaitResult,
  SpawnExperimentInput
} from '../types.js';

interface ExperimentManagerOptions {
  cwd: string;
  stateDir: string;
  notebook: Notebook;
  onChange(): void;
  onResolved(resolution: ExperimentResolution): void;
  startSubagent(experiment: ExperimentRecord): Promise<void>;
}

const MAX_RUNNING_EXPERIMENTS = 5;

export class ExperimentManager {
  private readonly running = new Map<string, Promise<void>>();
  private readonly activeRecords = new Map<string, ExperimentRecord>();

  constructor(private readonly options: ExperimentManagerOptions) {}

  async spawn(input: SpawnExperimentInput): Promise<ExperimentRecord> {
    if (this.running.size >= MAX_RUNNING_EXPERIMENTS) {
      throw new Error(
        `Only ${MAX_RUNNING_EXPERIMENTS} experiments can run at a time in v0.1. Wait for one to resolve before spawning another.`
      );
    }

    const baseCommitSha = await this.readBaseCommit();
    const id = createExperimentId();
    const worktreeRoot = path.join(this.options.stateDir, 'worktrees');
    const worktreePath = path.join(worktreeRoot, id);
    const branchName = `h2-${id}`;
    const createdAt = nowIso();

    await mkdir(worktreeRoot, { recursive: true });
    await execa('git', ['worktree', 'add', '-b', branchName, worktreePath, baseCommitSha], {
      cwd: this.options.cwd
    });

    this.options.notebook.createSession(this.getExperimentSessionId(id), worktreePath);

    const record: ExperimentRecord = {
      id,
      sessionId: input.sessionId,
      hypothesis: input.hypothesis,
      command: 'subagent',
      context: input.context ?? '',
      baseCommitSha,
      branchName,
      worktreePath,
      status: 'running',
      budget: input.budgetTokens,
      tokensUsed: 0,
      contextTokensUsed: 0,
      toolOutputTokensUsed: 0,
      observationTokensUsed: 0,
      preserve: input.preserve,
      createdAt,
      updatedAt: createdAt,
      resolvedAt: null,
      finalVerdict: null,
      finalSummary: null,
      discovered: [],
      promote: false
    };

    this.activeRecords.set(record.id, record);
    this.consumeTokens(record, `Hypothesis: ${record.hypothesis}`, 'context');
    if (record.context) {
      this.consumeTokens(record, `Context: ${record.context}`, 'context');
    }
    this.options.notebook.upsertExperiment(record);
    await this.appendObservation(record, `Spawned isolated worktree at ${record.worktreePath}.`, ['discovery']);
    await this.appendObservation(record, `Hypothesis: ${record.hypothesis}`, ['question']);
    if (record.context) {
      await this.appendObservation(record, `Context: ${record.context}`, ['discovery']);
    }

    const task = this.execute(record).finally(() => {
      this.running.delete(record.id);
      this.activeRecords.delete(record.id);
      this.options.onChange();
    });

    this.running.set(record.id, task);
    this.options.onChange();
    return record;
  }

  read(experimentId: string): ExperimentDetails {
    const details = this.options.notebook.getExperimentDetails(experimentId);
    if (!details) {
      throw new Error(`Unknown experiment: ${experimentId}`);
    }

    return details;
  }

  async waitForResolution(
    experimentId: string,
    timeoutMs = 2_000
  ): Promise<ExperimentWaitResult> {
    const start = Date.now();
    const normalizedTimeout = Math.max(0, timeoutMs);

    while (true) {
      const experiment = this.read(experimentId);
      if (experiment.status !== 'running') {
        return this.toWaitResult(experiment, false);
      }

      if (Date.now() - start >= normalizedTimeout) {
        return this.toWaitResult(experiment, true);
      }

      const remaining = normalizedTimeout - (Date.now() - start);
      await delay(Math.min(250, Math.max(25, remaining)));
    }
  }

  search(sessionId: string, query?: string): ExperimentSearchResult[] {
    return this.options.notebook.searchExperimentSummaries(sessionId, query);
  }

  async logObservation(
    experimentId: string,
    message: string,
    tags: ExperimentObservationTag[] = []
  ): Promise<ExperimentDetails> {
    const record = this.getMutableRecord(experimentId);
    this.assertRunning(record);
    await this.appendObservation(record, message, tags);
    return this.read(experimentId);
  }

  async resolve(input: {
    experimentId: string;
    verdict: ExperimentRecord['status'];
    summary: string;
    discovered: string[];
    promote: boolean;
  }): Promise<ExperimentResolution> {
    const record = this.getMutableRecord(input.experimentId);
    if (record.status !== 'running') {
      return this.toResolution(record);
    }

    const preserved = record.preserve || input.promote;
    const resolvedAt = nowIso();

    record.status = input.verdict;
    record.finalVerdict = input.verdict;
    record.finalSummary = clampText(input.summary, 4000);
    record.discovered = input.discovered.map((item) => clampText(item, 500));
    record.promote = input.promote;
    record.preserve = preserved;
    record.updatedAt = resolvedAt;
    record.resolvedAt = resolvedAt;

    if (record.promote) {
      await this.appendObservation(
        record,
        `Promotion requested. Inspect ${record.worktreePath} on branch ${record.branchName} before adopting changes.`,
        ['promising'],
        { countBudget: false }
      );
    } else {
      await this.cleanup(record);
    }

    this.options.notebook.upsertExperiment(record);
    const resolution = this.toResolution(record);
    this.options.onResolved(resolution);
    this.options.onChange();
    return resolution;
  }

  async recordToolUsage(experimentId: string, text: string): Promise<void> {
    const record = this.getMutableRecord(experimentId);
    this.assertRunning(record);
    this.consumeTokens(record, text, 'tool_output');
    this.options.notebook.upsertExperiment(record);
    await this.autoResolveBudgetIfNeeded(record);
    this.options.onChange();
  }

  getExperimentSessionId(experimentId: string): string {
    return `experiment-${experimentId}`;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.running.values());
  }

  private async execute(record: ExperimentRecord): Promise<void> {
    try {
      await this.options.startSubagent(record);

      const fresh = this.read(record.id);
      if (fresh.status === 'running') {
        await this.resolve({
          experimentId: record.id,
          verdict: 'inconclusive',
          summary: 'Experiment session ended without calling resolve_experiment.',
          discovered: [],
          promote: false
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (record.status === 'running') {
        await this.appendObservation(
          record,
          `Subagent failed before resolution:\n${clampText(message, 4000)}`,
          ['blocker'],
          { countBudget: false }
        );
        await this.resolve({
          experimentId: record.id,
          verdict: 'inconclusive',
          summary: clampText(message, 4000),
          discovered: record.discovered,
          promote: false
        });
      }
    }
  }

  private async cleanup(record: ExperimentRecord): Promise<void> {
    if (record.preserve) {
      await this.appendObservation(record, 'Preserving worktree after resolution.', ['conclusion'], {
        countBudget: false
      });
      return;
    }

    try {
      await access(record.worktreePath);
    } catch {
      return;
    }

    try {
      await execa('git', ['worktree', 'remove', '--force', record.worktreePath], {
        cwd: this.options.cwd
      });
      await execa('git', ['branch', '-D', record.branchName], {
        cwd: this.options.cwd,
        reject: false
      });
      await this.appendObservation(record, 'Removed temporary worktree.', ['conclusion'], {
        countBudget: false
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.appendObservation(
        record,
        `Worktree cleanup failed:\n${clampText(message, 4000)}`,
        ['blocker'],
        { countBudget: false }
      );
    }
  }

  private async appendObservation(
    record: ExperimentRecord,
    message: string,
    tags: ExperimentObservationTag[],
    options: { countBudget?: boolean } = {}
  ): Promise<void> {
    const trimmed = clampText(message, 6000);

    if (options.countBudget !== false) {
      this.consumeTokens(record, trimmed, 'observation');
    }

    record.updatedAt = nowIso();
    this.options.notebook.upsertExperiment(record);
    this.options.notebook.appendObservation(record.id, trimmed, tags);
    await this.autoResolveBudgetIfNeeded(record);
    this.options.onChange();
  }

  private consumeTokens(
    record: ExperimentRecord,
    text: string,
    source: 'context' | 'tool_output' | 'observation'
  ): void {
    const count = estimateTokens(text);
    record.tokensUsed += count;
    if (source === 'context') {
      record.contextTokensUsed += count;
    } else if (source === 'tool_output') {
      record.toolOutputTokensUsed += count;
    } else {
      record.observationTokensUsed += count;
    }
    record.updatedAt = nowIso();
  }

  private async autoResolveBudgetIfNeeded(record: ExperimentRecord): Promise<void> {
    if (record.status !== 'running' || record.tokensUsed <= record.budget) {
      return;
    }

    this.options.notebook.appendObservation(
      record.id,
      `Budget exhausted after ${record.tokensUsed}/${record.budget} estimated tokens.`,
      ['blocker', 'conclusion']
    );

    await this.resolve({
      experimentId: record.id,
      verdict: 'inconclusive',
      summary: `Budget exhausted after ${record.tokensUsed}/${record.budget} estimated tokens.`,
      discovered: record.discovered,
      promote: false
    });
  }

  private getMutableRecord(experimentId: string): ExperimentRecord {
    const active = this.activeRecords.get(experimentId);
    if (active) {
      return active;
    }

    const persisted = this.options.notebook.getExperiment(experimentId);
    if (!persisted) {
      throw new Error(`Unknown experiment: ${experimentId}`);
    }

    return persisted;
  }

  private assertRunning(record: ExperimentRecord): void {
    if (record.status !== 'running') {
      throw new Error(`Experiment ${record.id} is already resolved.`);
    }
  }

  private toResolution(record: ExperimentRecord): ExperimentResolution {
    return {
      id: record.id,
      verdict: record.finalVerdict ?? record.status,
      summary: record.finalSummary ?? '',
      discovered: record.discovered,
      promote: record.promote,
      preserved: record.preserve,
      worktreePath: record.worktreePath,
      branchName: record.branchName,
      baseCommitSha: record.baseCommitSha,
      tokensUsed: record.tokensUsed,
      contextTokensUsed: record.contextTokensUsed,
      toolOutputTokensUsed: record.toolOutputTokensUsed,
      observationTokensUsed: record.observationTokensUsed,
      budget: record.budget,
      hypothesis: record.hypothesis,
      resolvedAt: record.resolvedAt ?? record.updatedAt
    };
  }

  private toWaitResult(experiment: ExperimentDetails, timedOut: boolean): ExperimentWaitResult {
    const lastObservation = experiment.observations.at(-1);
    return {
      timedOut,
      experimentId: experiment.id,
      hypothesis: experiment.hypothesis,
      status: experiment.status,
      summary: experiment.finalSummary ?? '',
      discovered: experiment.discovered,
      tokensUsed: experiment.tokensUsed,
      contextTokensUsed: experiment.contextTokensUsed,
      toolOutputTokensUsed: experiment.toolOutputTokensUsed,
      observationTokensUsed: experiment.observationTokensUsed,
      budget: experiment.budget,
      lastObservationAt: lastObservation?.createdAt ?? null,
      lastObservationSnippet: lastObservation
        ? clampText(lastObservation.message, 240)
        : null
    };
  }

  private async readBaseCommit(): Promise<string> {
    const result = await execa('git', ['rev-parse', 'HEAD'], {
      cwd: this.options.cwd
    });
    return lines(result.stdout)[0] ?? '';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
