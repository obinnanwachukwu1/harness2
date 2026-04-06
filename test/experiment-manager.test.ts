import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { ExperimentManager } from '../src/experiments/experiment-manager.js';
import { Notebook } from '../src/storage/notebook.js';
import { cleanupDir, createGitRepo, pathExists, waitFor } from '../test-support/helpers.js';

test('ExperimentManager validates and removes worktree by default', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const manager = new ExperimentManager({
    cwd: repoDir,
    stateDir: path.join(repoDir, '.h2'),
    notebook,
    onChange() {}
  });
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'node is available in the worktree',
    command: 'node --version',
    budget: 1200,
    preserve: false
  });

  const resolved = await waitFor(
    () => manager.read(experiment.id),
    (details) => details.status !== 'running'
  );

  assert.equal(resolved.finalVerdict, 'validated');
  assert.equal(await pathExists(experiment.worktreePath), false);
});

test('ExperimentManager can preserve an invalidated experiment worktree', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const manager = new ExperimentManager({
    cwd: repoDir,
    stateDir: path.join(repoDir, '.h2'),
    notebook,
    onChange() {}
  });
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'this ref should not exist',
    command: 'git rev-parse does-not-exist',
    budget: 1200,
    preserve: true
  });

  const resolved = await waitFor(
    () => manager.read(experiment.id),
    (details) => details.status !== 'running'
  );

  assert.equal(resolved.finalVerdict, 'invalidated');
  assert.equal(await pathExists(experiment.worktreePath), true);
});
