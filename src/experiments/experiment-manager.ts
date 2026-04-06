import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';

import { execa, execaCommand } from 'execa';

import { clampText, createExperimentId, estimateTokens, lines, nowIso } from '../lib/utils.js';
import { Notebook } from '../storage/notebook.js';
import type { ExperimentDetails, ExperimentRecord, SpawnExperimentInput } from '../types.js';

interface ExperimentManagerOptions {
  cwd: string;
  stateDir: string;
  notebook: Notebook;
  onChange(): void;
}

export class ExperimentManager {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly options: ExperimentManagerOptions) {}

  async spawn(input: SpawnExperimentInput): Promise<ExperimentRecord> {
    if (this.running.size > 0) {
      throw new Error('Only one experiment can run at a time in v0.1.');
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

    const record: ExperimentRecord = {
      id,
      sessionId: input.sessionId,
      hypothesis: input.hypothesis,
      command: input.command,
      context: input.context ?? '',
      baseCommitSha,
      branchName,
      worktreePath,
      status: 'running',
      budget: input.budget,
      tokensUsed: 0,
      preserve: input.preserve,
      createdAt,
      updatedAt: createdAt,
      resolvedAt: null,
      finalVerdict: null,
      finalSummary: null
    };

    this.options.notebook.upsertExperiment(record);
    this.observe(record, `Spawned worktree ${worktreePath}`);
    this.observe(record, `Hypothesis: ${input.hypothesis}`);
    if (record.context) {
      this.observe(record, `Context: ${record.context}`);
    }
    this.observe(record, `Command: ${input.command}`);

    const task = this.execute(record).finally(() => {
      this.running.delete(record.id);
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

  async dispose(): Promise<void> {
    await Promise.allSettled(this.running.values());
  }

  private async execute(record: ExperimentRecord): Promise<void> {
    let verdict: ExperimentRecord['status'] = 'inconclusive';
    let summary = 'Experiment ended without a recorded result.';

    try {
      this.observe(record, 'Running experiment command in isolated worktree.');

      const result = await execaCommand(record.command, {
        cwd: record.worktreePath,
        shell: true,
        reject: false
      });

      if (result.stdout.trim()) {
        this.observe(record, `stdout:\n${clampText(result.stdout)}`);
      }

      if (result.stderr.trim()) {
        this.observe(record, `stderr:\n${clampText(result.stderr)}`);
      }

      const diff = await execa('git', ['diff', '--stat'], {
        cwd: record.worktreePath,
        reject: false
      });

      if (diff.stdout.trim()) {
        this.observe(record, `diff stat:\n${clampText(diff.stdout)}`);
      }

      verdict = result.exitCode === 0 ? 'validated' : 'invalidated';
      summary =
        result.exitCode === 0
          ? `Command succeeded with exit code 0 in ${record.worktreePath}.`
          : `Command exited with code ${result.exitCode}.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.observe(record, `Experiment failed before validation:\n${message}`);
      verdict = 'inconclusive';
      summary = message;
    }

    await this.cleanup(record);

    record.status = verdict;
    record.finalVerdict = verdict;
    record.finalSummary = summary;
    record.updatedAt = nowIso();
    record.resolvedAt = record.updatedAt;
    this.options.notebook.upsertExperiment(record);
    this.options.onChange();
  }

  private async cleanup(record: ExperimentRecord): Promise<void> {
    if (record.preserve) {
      this.observe(record, 'Preserving worktree after resolution.');
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
      this.observe(record, 'Removed temporary worktree.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.observe(record, `Worktree cleanup failed:\n${message}`);
    }
  }

  private observe(record: ExperimentRecord, message: string): void {
    const trimmed = clampText(message, 6000);
    const tokens = estimateTokens(trimmed);
    record.tokensUsed += tokens;
    record.updatedAt = nowIso();

    this.options.notebook.upsertExperiment(record);
    this.options.notebook.appendObservation(record.id, trimmed);
    this.options.onChange();
  }

  private async readBaseCommit(): Promise<string> {
    const result = await execa('git', ['rev-parse', 'HEAD'], {
      cwd: this.options.cwd
    });
    return lines(result.stdout)[0] ?? '';
  }
}
