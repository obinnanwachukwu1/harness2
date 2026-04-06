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
  resolved: ExperimentResolution[] = []
): ExperimentManager {
  let manager: ExperimentManager;
  manager = new ExperimentManager({
    cwd: repoDir,
    stateDir: path.join(repoDir, '.harness2'),
    notebook,
    onChange() {},
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

test('ExperimentManager auto-resolves inconclusive when the budget is exhausted', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const resolved: ExperimentResolution[] = [];
  const manager = createManager(repoDir, notebook, async (experiment, currentManager) => {
    await currentManager.logObservation(
      experiment.id,
      'x'.repeat(2000),
      ['blocker']
    );
  }, resolved);
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'force budget exhaustion',
    budgetTokens: 10,
    preserve: false
  });

  const details = await waitFor(
    () => manager.read(experiment.id),
    (value) => value.status !== 'running'
  );

  assert.equal(details.finalVerdict, 'inconclusive');
  assert.match(details.finalSummary ?? '', /Budget exhausted/);
  assert.ok(details.observations.some((entry) => entry.message.includes('Budget exhausted')));
  assert.equal(resolved[0]?.verdict, 'inconclusive');
  assert.ok((resolved[0]?.observationTokensUsed ?? 0) > 0);
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
