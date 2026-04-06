import assert from 'node:assert/strict';
import test from 'node:test';

import { HeadlessEngine } from '../src/engine/headless-engine.js';
import { cleanupDir, createGitRepo, waitFor } from '../test-support/helpers.js';

test('HeadlessEngine routes slash commands through the prototype runner', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  await engine.submit('/write notes.txt :: hello from harness2');
  await engine.submit('/read notes.txt');
  await engine.submit(
    '/spawn --hypothesis "run a trivial command in isolation" --cmd "node --version"'
  );

  await waitFor(
    () => engine.snapshot.experiments[0],
    (experiment) => Boolean(experiment) && experiment.status !== 'running'
  );

  const transcript = engine.snapshot.transcript.map((entry) => entry.text).join('\n\n');
  assert.match(transcript, /Wrote 19 chars to notes\.txt\./);
  assert.match(transcript, /notes\.txt/);
  assert.match(transcript, /Spawned exp-/);
  assert.equal(engine.snapshot.experiments.length, 1);
  assert.equal(engine.snapshot.experiments[0]?.finalVerdict, 'validated');
});
