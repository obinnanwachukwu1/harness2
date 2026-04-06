import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { ExperimentManager } from '../src/experiments/experiment-manager.js';
import type { ExperimentRecord, ExperimentResolution } from '../src/types.js';
import { Notebook } from '../src/storage/notebook.js';
import { cleanupDir, createGitRepo, pathExists, waitFor } from '../test-support/helpers.js';

function createManager(
  repoDir: string,
  notebook: Notebook,
  startSubagent: (experiment: ExperimentRecord, manager: ExperimentManager) => Promise<void>,
  resolved: ExperimentResolution[] = [],
  budgetNotifications: string[] = []
): ExperimentManager {
  let manager: ExperimentManager;
  manager = new ExperimentManager({
    cwd: repoDir,
    stateDir: path.join(repoDir, '.harness2'),
    notebook,
    onChange() {},
    onBudgetExceeded(notification) {
      budgetNotifications.push(notification.message);
    },
    onQualitySignal() {},
    onResolved(resolution) {
      resolved.push(resolution);
    },
    startSubagent: (experiment) => startSubagent(experiment, manager)
  });
  return manager;
}

test('ExperimentManager spawn creates worktree and persists a running record', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  let started = false;
  const manager = createManager(repoDir, notebook, async () => {
    started = true;
  });
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'investigate the repo safely',
    budgetTokens: 1200,
    preserve: false
  });

  assert.equal(started, true);
  assert.equal(await pathExists(experiment.worktreePath), true);
  assert.equal(manager.read(experiment.id).status, 'running');
  assert.equal(notebook.getExperiment(experiment.id)?.hypothesis, 'investigate the repo safely');
});

test('ExperimentManager logObservation appends tagged notes to durable state', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const manager = createManager(repoDir, notebook, async (experiment, currentManager) => {
    await currentManager.logObservation(experiment.id, 'found the target file', ['discovery', 'promising']);
  });
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'look for a useful clue',
    budgetTokens: 1200,
    preserve: false
  });

  const details = await waitFor(
    () => manager.read(experiment.id),
    (value) => value.observations.some((entry) => entry.message.includes('found the target file'))
  );

  const observation = details.observations.find((entry) => entry.message.includes('found the target file'));
  assert.deepEqual(observation?.tags, ['discovery', 'promising']);
  assert.ok(details.contextTokensUsed > 0);
  assert.ok(details.observationTokensUsed > 0);
});

test('ExperimentManager resolve updates status and removes or preserves the worktree', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const resolved: ExperimentResolution[] = [];
  const manager = createManager(repoDir, notebook, async (experiment, currentManager) => {
    await currentManager.resolve({
      experimentId: experiment.id,
      verdict: 'validated',
      summary: 'safe to adopt',
      discovered: ['notes.txt changed'],
      artifacts: ['notes.txt'],
      constraints: ['review before adopt'],
      confidenceNote: 'Directly observed in worktree.',
      promote: false
    });
  }, resolved);
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'confirm worktree cleanup',
    budgetTokens: 1200,
    preserve: false
  });

  const firstResolution = await waitFor(
    () => manager.read(experiment.id),
    (value) => value.status !== 'running'
  );

  assert.equal(firstResolution.finalVerdict, 'validated');
  assert.equal(await pathExists(experiment.worktreePath), false);
  assert.equal(resolved[0]?.promote, false);

  const preservedManager = createManager(repoDir, notebook, async (nextExperiment, currentManager) => {
    await currentManager.resolve({
      experimentId: nextExperiment.id,
      verdict: 'validated',
      summary: 'keep this worktree for handoff',
      discovered: ['patch ready'],
      artifacts: ['patch-ready worktree'],
      constraints: ['manual inspection before adoption'],
      confidenceNote: 'Promoted for handoff.',
      promote: true
    });
  });
  t.after(async () => preservedManager.dispose());

  const preserved = await preservedManager.spawn({
    sessionId: 'session-test',
    hypothesis: 'preserve promoted result',
    budgetTokens: 1200,
    preserve: false
  });

  const secondResolution = await waitFor(
    () => preservedManager.read(preserved.id),
    (value) => value.status !== 'running'
  );

  assert.equal(secondResolution.promote, true);
  assert.equal(await pathExists(preserved.worktreePath), true);
});

test('ExperimentManager pauses and notifies when the budget is exhausted', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const resolved: ExperimentResolution[] = [];
  const budgetNotifications: string[] = [];
  const manager = createManager(repoDir, notebook, async (experiment, currentManager) => {
    await currentManager.logObservation(
      experiment.id,
      'x'.repeat(2000),
      ['blocker']
    );
  }, resolved, budgetNotifications);
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'force budget exhaustion',
    budgetTokens: 300,
    preserve: false
  });

  const details = await waitFor(
    () => manager.read(experiment.id),
    (value) => value.status !== 'running'
  );

  assert.equal(details.status, 'budget_exhausted');
  assert.equal(details.finalVerdict, null);
  assert.equal(details.finalSummary, null);
  assert.ok(details.observations.some((entry) => entry.message.includes('Budget exhausted')));
  assert.equal(resolved.length, 0);
  assert.equal(budgetNotifications.length, 1);
  assert.ok(details.observationTokensUsed > 0);
});

test('ExperimentManager can extend a budget-exhausted experiment and resume it', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const resolved: ExperimentResolution[] = [];
  let runCount = 0;
  const manager = createManager(repoDir, notebook, async (experiment, currentManager) => {
    runCount += 1;
    if (runCount === 1) {
      await currentManager.logObservation(experiment.id, 'x'.repeat(2000), ['blocker']);
      return;
    }

    await currentManager.resolve({
      experimentId: experiment.id,
      verdict: 'validated',
      summary: 'continued after adding more budget',
      discovered: ['resume path works'],
      artifacts: ['resume evidence'],
      constraints: ['requires additional budget'],
      confidenceNote: 'Observed after second run.',
      promote: false
    });
  }, resolved);
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'resume after budget extension',
    budgetTokens: 300,
    preserve: false
  });

  await waitFor(
    () => manager.read(experiment.id),
    (value) => value.status === 'budget_exhausted'
  );

  const resumed = await manager.extendBudget(experiment.id, 5000);
  assert.equal(resumed.budget, 5300);

  const final = await waitFor(
    () => manager.read(experiment.id),
    (value) => value.status === 'validated'
  );

  assert.equal(final.finalVerdict, 'validated');
  assert.match(final.finalSummary ?? '', /continued after adding more budget/);
  assert.equal(runCount, 2);
  assert.equal(resolved[0]?.verdict, 'validated');
});

test('ExperimentManager emits a low-signal warning after heavy tool output without findings', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const qualityNotifications: string[] = [];
  const manager = new ExperimentManager({
    cwd: repoDir,
    stateDir: path.join(repoDir, '.harness2'),
    notebook,
    onChange() {},
    onBudgetExceeded() {},
    onQualitySignal(notification) {
      qualityNotifications.push(notification.message);
    },
    onResolved() {},
    startSubagent: async (experiment) => {
      await manager.recordToolUsage(experiment.id, 'x'.repeat(6_000));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'warn on low-signal probing',
    budgetTokens: 10_000,
    preserve: false
  });

  const details = await waitFor(
    () => manager.read(experiment.id),
    (value) => value.lowSignalWarningEmitted
  );

  assert.equal(details.lowSignalWarningEmitted, true);
  assert.ok(
    details.observations.some((entry) => entry.message.includes('Low-signal warning'))
  );
  assert.equal(qualityNotifications.length, 1);
});

test('ExperimentManager waitForResolution returns timedOut when an experiment is still running', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const manager = createManager(repoDir, notebook, async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'wait should time out cleanly',
    budgetTokens: 1200,
    preserve: false
  });

  const result = await manager.waitForResolution(experiment.id, 50);
  assert.equal(result.timedOut, true);
  assert.equal(result.status, 'running');
  assert.equal(result.experimentId, experiment.id);
  assert.equal(typeof result.lastObservationSnippet, 'string');
  assert.equal('observations' in result, false);
});

test('ExperimentManager waitForResolution returns the resolved experiment when it finishes in time', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const manager = createManager(repoDir, notebook, async (experiment, currentManager) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await currentManager.resolve({
      experimentId: experiment.id,
      verdict: 'validated',
      summary: 'finished while waiting',
      discovered: ['resolved in wait window'],
      artifacts: ['wait resolution'],
      constraints: [],
      confidenceNote: 'Resolved during bounded wait.',
      promote: false
    });
  });
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'wait should observe resolution',
    budgetTokens: 1200,
    preserve: false
  });

  const result = await manager.waitForResolution(experiment.id, 500);
  assert.equal(result.timedOut, false);
  assert.equal(result.status, 'validated');
  assert.equal(result.summary, 'finished while waiting');
  assert.deepEqual(result.discovered, ['resolved in wait window']);
});

test('ExperimentManager allows up to five concurrent experiments and rejects the sixth', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  let releaseRunning: (() => void) | undefined;
  const runningBlocker = new Promise<void>((resolve) => {
    releaseRunning = resolve;
  });

  const manager = createManager(repoDir, notebook, async () => {
    await runningBlocker;
  });
  t.after(async () => {
    releaseRunning?.();
    await manager.dispose();
  });

  const experiments = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      manager.spawn({
        sessionId: 'session-test',
        hypothesis: `concurrency slot ${index + 1}`,
        budgetTokens: 1200,
        preserve: false
      })
    )
  );

  assert.equal(experiments.length, 5);

  await assert.rejects(
    () =>
      manager.spawn({
        sessionId: 'session-test',
        hypothesis: 'should exceed the concurrency limit',
        budgetTokens: 1200,
        preserve: false
      }),
    /Only 5 experiments can run at a time/
  );
});
