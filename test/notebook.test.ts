import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { Notebook } from '../src/storage/notebook.js';
import type { ExperimentRecord } from '../src/types.js';
import { nowIso } from '../src/lib/utils.js';
import { cleanupDir, createTempDir } from '../test-support/helpers.js';

test('Notebook persists transcript and experiment details', async (t) => {
  const tempDir = await createTempDir('h2-notebook-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());

  const session = notebook.createSession('session-test', tempDir);
  notebook.appendTranscript(session.id, 'user', 'hello');
  notebook.appendTranscript(session.id, 'assistant', 'world');

  const timestamp = nowIso();
  const experiment: ExperimentRecord = {
    id: 'exp-test',
    sessionId: session.id,
    hypothesis: 'writing observations is durable',
    command: 'node --version',
    context: 'test context',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-test',
    worktreePath: path.join(tempDir, 'worktree'),
    status: 'validated',
    budget: 1200,
    tokensUsed: 42,
    preserve: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: timestamp,
    finalVerdict: 'validated',
    finalSummary: 'looks good'
  };

  notebook.upsertExperiment(experiment);
  notebook.appendObservation(experiment.id, 'first observation');

  const snapshot = notebook.getSnapshot(session.id, false, 'idle');
  assert.equal(snapshot.transcript.length, 2);
  assert.equal(snapshot.experiments.length, 1);
  assert.equal(snapshot.experiments[0]?.id, experiment.id);

  const details = notebook.getExperimentDetails(experiment.id);
  assert.ok(details);
  assert.equal(details?.observations.length, 1);
  assert.equal(details?.observations[0]?.message, 'first observation');
});
