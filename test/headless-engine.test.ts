import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { execa } from 'execa';

import { HeadlessEngine } from '../src/engine/headless-engine.js';
import { DEFAULT_EXPERIMENT_BUDGET_TOKENS, nowIso } from '../src/lib/utils.js';
import { cleanupDir, createGitRepo, waitFor } from '../test-support/helpers.js';

test('HeadlessEngine routes slash commands through the prototype runner', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  await engine.submit('/write notes.txt :: hello from harness2');
  await engine.submit('/read notes.txt');
  await engine.submit('/spawn --hypothesis "inspect the repo in isolation"');

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
  assert.equal(engine.snapshot.experiments[0]?.budget, DEFAULT_EXPERIMENT_BUDGET_TOKENS);
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
    artifacts: [],
    constraints: [],
    confidenceNote: null,
    lowSignalWarningEmitted: false,
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

test('HeadlessEngine submit can stream transcript callbacks for noninteractive callers', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const emitted: Array<{ role: string; text: string }> = [];
  await engine.submit('/read README.md', {
    onTranscriptEntry: async (role, text) => {
      emitted.push({ role, text });
    }
  });

  assert.ok(emitted.some((entry) => entry.role === 'tool' || entry.role === 'assistant'));
  assert.ok(emitted.some((entry) => entry.text.includes('README.md')));
});

test('HeadlessEngine can preview and apply a preserved experiment back into the main workspace', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const baseCommitSha = (
    await execa('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir
    })
  ).stdout.trim();
  const worktreePath = path.join(repoDir, '.harness2', 'worktrees', 'exp-adopt');
  await execa('git', ['worktree', 'add', '-b', 'h2-exp-adopt', worktreePath, 'HEAD'], {
    cwd: repoDir
  });

  await writeFile(path.join(worktreePath, 'feature.txt'), 'hello from experiment\n', 'utf8');
  await writeFile(path.join(worktreePath, 'README.md'), '# temp repo\nupdated by experiment\n', 'utf8');

  const notebook = (engine as any).options.notebook;
  const timestamp = nowIso();
  notebook.upsertExperiment({
    id: 'exp-adopt',
    sessionId: engine.snapshot.session.id,
    hypothesis: 'preserved changes should be adoptable',
    command: 'subagent',
    context: '',
    baseCommitSha,
    branchName: 'h2-exp-adopt',
    worktreePath,
    status: 'validated',
    budget: 50000,
    tokensUsed: 100,
    contextTokensUsed: 10,
    toolOutputTokensUsed: 70,
    observationTokensUsed: 20,
    preserve: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: timestamp,
    finalVerdict: 'validated',
    finalSummary: 'experiment produced reusable changes',
    discovered: ['tracked and untracked changes available'],
    artifacts: ['feature.txt'],
    constraints: [],
    confidenceNote: 'high confidence for local adoption',
    lowSignalWarningEmitted: false,
    promote: true
  });

  await engine.submit('/adopt exp-adopt');
  let transcript = engine.snapshot.transcript.map((entry) => entry.text).join('\n\n');
  assert.match(transcript, /Experiment adoption preview/);
  assert.match(transcript, /feature\.txt/);
  assert.match(transcript, /Run \/adopt exp-adopt --apply/);

  const rootReadmeBefore = await readFile(path.join(repoDir, 'README.md'), 'utf8');
  assert.equal(rootReadmeBefore, '# temp repo\n');

  await engine.submit('/adopt exp-adopt --apply');
  transcript = engine.snapshot.transcript.map((entry) => entry.text).join('\n\n');
  assert.match(transcript, /Experiment adoption applied/);
  assert.match(transcript, /rollback: h2-adopt-backup-/);

  const rootReadmeAfter = await readFile(path.join(repoDir, 'README.md'), 'utf8');
  const adoptedFile = await readFile(path.join(repoDir, 'feature.txt'), 'utf8');
  assert.match(rootReadmeAfter, /updated by experiment/);
  assert.equal(adoptedFile, 'hello from experiment\n');
});
