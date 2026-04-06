import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { HeadlessEngine } from '../src/engine/headless-engine.js';
import { nowIso } from '../src/lib/utils.js';
import { cleanupDir, createGitRepo, waitFor } from '../test-support/helpers.js';

test('HeadlessEngine routes slash commands through the prototype runner', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  await engine.submit('/write notes.txt :: hello from harness2');
  await engine.submit('/read notes.txt');
  await engine.submit('/spawn --hypothesis "inspect the repo in isolation" --budget 1200');

  await waitFor(
    () => engine.snapshot.experiments[0],
    (experiment) => Boolean(experiment) && experiment.status !== 'running'
  );

  const transcript = engine.snapshot.transcript.map((entry) => entry.text).join('\n\n');
  assert.match(transcript, /Wrote 19 chars to notes\.txt\./);
  assert.match(transcript, /notes\.txt/);
  assert.match(transcript, /Spawned exp-/);
  assert.match(transcript, /Experiment resolved/);
  assert.equal(engine.snapshot.experiments.length, 1);
  assert.equal(engine.snapshot.experiments[0]?.finalVerdict, 'inconclusive');
});

test('HeadlessEngine compact persists harness checkpoint with git state and active experiments', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const notebook = (engine as any).options.notebook;
  const timestamp = nowIso();
  notebook.upsertExperiment({
    id: 'exp-running',
    sessionId: engine.snapshot.session.id,
    hypothesis: 'verify checkpoint captures running experiments',
    command: 'subagent',
    context: '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-running',
    worktreePath: path.join(repoDir, '.harness2', 'worktrees', 'exp-running'),
    status: 'running',
    budget: 5000,
    tokensUsed: 10,
    contextTokensUsed: 4,
    toolOutputTokensUsed: 3,
    observationTokensUsed: 3,
    preserve: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: null,
    finalVerdict: null,
    finalSummary: null,
    discovered: [],
    promote: false
  });

  const result = await (engine as any).runCompact(
    'verify checkpointing',
    'seeded a running experiment',
    'continue with shorter replay',
    'subagent may still fail'
  );
  assert.equal(result.ok, true);
  assert.equal(typeof result.checkpointId, 'number');

  const checkpoint = notebook.getLatestSessionCheckpoint(engine.snapshot.session.id);
  assert.ok(checkpoint);
  assert.match(checkpoint?.gitLog ?? '', /\b[0-9a-f]{7,}\b/);
  assert.match(checkpoint?.checkpointBlock ?? '', /active_experiments:/);
  assert.equal(checkpoint?.activeExperimentSummaries[0]?.experimentId, 'exp-running');
});
