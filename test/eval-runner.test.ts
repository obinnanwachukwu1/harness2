import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { runEvalSuite } from '../src/evals/suite-runner.js';
import { createEvalReviewPack } from '../src/evals/pack-run.js';
import { createEvalRunBatchRecord } from '../src/evals/repeat-batches.js';
import { cleanupDir, createGitRepo, createTempDir } from '../test-support/helpers.js';

test('runEvalSuite materializes template fixture env and exports artifacts', async (t) => {
  const tempDir = await createTempDir('h2-eval-runner-');
  t.after(async () => cleanupDir(tempDir));

  const originalH2Home = process.env.H2_HOME;
  process.env.H2_HOME = path.join(tempDir, 'h2-home');
  t.after(() => {
    if (originalH2Home === undefined) {
      delete process.env.H2_HOME;
    } else {
      process.env.H2_HOME = originalH2Home;
    }
  });

  const fixtureDir = path.join(tempDir, 'fixtures', 'tiny-app');
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(path.join(fixtureDir, 'README.md'), '# fixture\n', 'utf8');
  const envSourcePath = path.join(tempDir, 'fixture.env');
  await writeFile(
    envSourcePath,
    ['OPENAI_API_KEY=secret-value', 'OPENAI_BASE_URL=http://127.0.0.1:8787', 'FLAG=true'].join('\n'),
    'utf8'
  );

  const manifestPath = path.join(tempDir, 'suite.toml');
  await writeFile(
    manifestPath,
    `
[suite]
id = "core-12"

[runtime]
reasoning_effort = "medium"
thinking = false
web_search_mode = "fixed"

[[fixtures]]
id = "tiny-app"
type = "template"
path = "./fixtures/tiny-app"
env_source = "./fixture.env"
write_env_file = ".env"
write_env_example = ".env.example"

[[cases]]
id = "A1"
bucket = "A"
fixture = "tiny-app"
profile = "backend"
prompt = "/write note.txt :: hello from eval"
question_expected = false
experiment_expected = false
`,
    'utf8'
  );

  const result = await runEvalSuite({
    manifestPath,
    selectedCaseIds: ['A1']
  });

  assert.equal(result.cases.length, 1);
  const caseResult = result.cases[0]!;
  assert.equal(caseResult.autoScore.questionActual, false);
  assert.equal(caseResult.autoScore.experimentActual, 0);

  await assert.doesNotReject(() => access(caseResult.artifacts.sessionMarkdownPath));
  await assert.doesNotReject(() => access(path.join(caseResult.workspacePath, 'note.txt')));
  assert.equal(await readFile(path.join(caseResult.workspacePath, 'note.txt'), 'utf8'), 'hello from eval');
  assert.equal(
    await readFile(path.join(caseResult.workspacePath, '.env'), 'utf8'),
    await readFile(envSourcePath, 'utf8')
  );
  assert.equal(
    await readFile(path.join(caseResult.workspacePath, '.env.example'), 'utf8'),
    ['OPENAI_API_KEY=', 'OPENAI_BASE_URL=http://127.0.0.1:8787', 'FLAG=true'].join('\n')
  );
  const runDir = path.dirname(path.dirname(caseResult.workspacePath));
  await assert.doesNotReject(() => access(path.join(runDir, 'score-sheet.csv')));
  await assert.doesNotReject(() => access(path.join(runDir, 'score-sheet.json')));
});

test('runEvalSuite supports git_checkout fixtures for a single case run', async (t) => {
  const tempDir = await createTempDir('h2-eval-git-checkout-');
  t.after(async () => cleanupDir(tempDir));
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const originalH2Home = process.env.H2_HOME;
  process.env.H2_HOME = path.join(tempDir, 'h2-home');
  t.after(() => {
    if (originalH2Home === undefined) {
      delete process.env.H2_HOME;
    } else {
      process.env.H2_HOME = originalH2Home;
    }
  });

  const manifestPath = path.join(tempDir, 'suite.toml');
  await writeFile(
    manifestPath,
    `
[suite]
id = "core-12"

[runtime]
reasoning_effort = "medium"
thinking = false
web_search_mode = "fixed"

[[fixtures]]
id = "repo-fixture"
type = "git_checkout"
path = "${repoDir.replace(/\\/g, '\\\\')}"
ref = "HEAD"

[[cases]]
id = "A2"
bucket = "A"
fixture = "repo-fixture"
profile = "existing"
prompt = "/read README.md"
question_expected = false
experiment_expected = false
`,
    'utf8'
  );

  const result = await runEvalSuite({
    manifestPath,
    selectedCaseIds: ['A2']
  });

  const transcript = JSON.parse(await readFile(result.cases[0]!.artifacts.transcriptJsonPath, 'utf8')) as Array<{ text: string }>;
  assert.ok(transcript.some((entry) => entry.text.includes('README.md')));
});

test('runEvalSuite supports bounded case parallelism', async (t) => {
  const tempDir = await createTempDir('h2-eval-parallel-');
  t.after(async () => cleanupDir(tempDir));

  const originalH2Home = process.env.H2_HOME;
  process.env.H2_HOME = path.join(tempDir, 'h2-home');
  t.after(() => {
    if (originalH2Home === undefined) {
      delete process.env.H2_HOME;
    } else {
      process.env.H2_HOME = originalH2Home;
    }
  });

  const fixtureDir = path.join(tempDir, 'fixtures', 'tiny-app');
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(path.join(fixtureDir, 'README.md'), '# fixture\n', 'utf8');

  const manifestPath = path.join(tempDir, 'suite.toml');
  await writeFile(
    manifestPath,
    `
[suite]
id = "core-12"

[runtime]
reasoning_effort = "medium"
thinking = false
web_search_mode = "fixed"
parallelism = 2

[[fixtures]]
id = "tiny-app"
type = "template"
path = "./fixtures/tiny-app"

[[cases]]
id = "A1"
bucket = "A"
fixture = "tiny-app"
profile = "backend"
prompt = "/write one.txt :: one"

[[cases]]
id = "A2"
bucket = "A"
fixture = "tiny-app"
profile = "backend"
prompt = "/write two.txt :: two"
`,
    'utf8'
  );

  const result = await runEvalSuite({
    manifestPath
  });

  assert.equal(result.cases.length, 2);
  assert.equal(await readFile(path.join(result.cases[0]!.workspacePath, 'one.txt'), 'utf8'), 'one');
  assert.equal(await readFile(path.join(result.cases[1]!.workspacePath, 'two.txt'), 'utf8'), 'two');
});

test('runEvalSuite applies runtime overrides such as mode when requested', async (t) => {
  const tempDir = await createTempDir('h2-eval-runtime-override-');
  t.after(async () => cleanupDir(tempDir));

  const originalH2Home = process.env.H2_HOME;
  process.env.H2_HOME = path.join(tempDir, 'h2-home');
  t.after(() => {
    if (originalH2Home === undefined) {
      delete process.env.H2_HOME;
    } else {
      process.env.H2_HOME = originalH2Home;
    }
  });

  const fixtureDir = path.join(tempDir, 'fixtures', 'tiny-app');
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(path.join(fixtureDir, 'README.md'), '# fixture\n', 'utf8');

  const manifestPath = path.join(tempDir, 'suite.toml');
  await writeFile(
    manifestPath,
    `
[suite]
id = "core-12"

[runtime]
reasoning_effort = "medium"
thinking = false
web_search_mode = "fixed"

[[fixtures]]
id = "tiny-app"
type = "template"
path = "./fixtures/tiny-app"

[[cases]]
id = "A1"
bucket = "A"
fixture = "tiny-app"
profile = "backend"
prompt = "/read README.md"
`,
    'utf8'
  );

  const result = await runEvalSuite({
    manifestPath,
    runtimeOverride: { mode: 'direct' }
  });

  assert.equal(result.cases[0]!.runtime.mode, 'direct');
  const lock = JSON.parse(
    await readFile(path.join(path.dirname(result.lockedManifestPath), 'manifest.lock.json'), 'utf8')
  ) as { runtime: { mode?: string } };
  assert.equal(lock.runtime.mode, 'direct');
});

test('createEvalReviewPack resolves a short run suffix and excludes workspaces', async (t) => {
  const tempDir = await createTempDir('h2-eval-pack-');
  t.after(async () => cleanupDir(tempDir));

  const originalH2Home = process.env.H2_HOME;
  process.env.H2_HOME = path.join(tempDir, 'h2-home');
  t.after(() => {
    if (originalH2Home === undefined) {
      delete process.env.H2_HOME;
    } else {
      process.env.H2_HOME = originalH2Home;
    }
  });

  const fixtureDir = path.join(tempDir, 'fixtures', 'tiny-app');
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(path.join(fixtureDir, 'README.md'), '# fixture\n', 'utf8');

  const manifestPath = path.join(tempDir, 'suite.toml');
  await writeFile(
    manifestPath,
    `
[suite]
id = "core-12"

[runtime]
reasoning_effort = "medium"
thinking = false
web_search_mode = "fixed"

[[fixtures]]
id = "tiny-app"
type = "template"
path = "./fixtures/tiny-app"

[[cases]]
id = "A1"
bucket = "A"
fixture = "tiny-app"
profile = "backend"
prompt = "/write note.txt :: hello"
`,
    'utf8'
  );

  const result = await runEvalSuite({
    manifestPath,
    runId: 'run-2026-04-09T02-17-35-426Z-0e5484'
  });

  const outputDir = path.join(tempDir, 'packs');
  const pack = await createEvalReviewPack({
    selector: '0e5484',
    outputDir
  });

  assert.equal(pack.kind, 'run');
  assert.equal(pack.runId, result.runId);
  assert.deepEqual(pack.runIds, [result.runId]);
  assert.deepEqual(pack.sourcePaths, [path.join(process.env.H2_HOME!, 'evals', result.runId)]);
  await assert.doesNotReject(() => access(pack.zipPath));
  assert.ok(pack.includedFiles.includes('manifest.lock.json'));
  assert.ok(pack.includedFiles.includes('score-sheet.csv'));
  assert.ok(pack.includedFiles.includes(path.join('A1', 'artifacts', 'session.md')));
  assert.ok(!pack.includedFiles.some((entry) => entry.includes('workspace')));
});

test('createEvalReviewPack can package the latest repeat batch', async (t) => {
  const tempDir = await createTempDir('h2-eval-pack-batch-');
  t.after(async () => cleanupDir(tempDir));

  const originalH2Home = process.env.H2_HOME;
  process.env.H2_HOME = path.join(tempDir, 'h2-home');
  t.after(() => {
    if (originalH2Home === undefined) {
      delete process.env.H2_HOME;
    } else {
      process.env.H2_HOME = originalH2Home;
    }
  });

  const fixtureDir = path.join(tempDir, 'fixtures', 'tiny-app');
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(path.join(fixtureDir, 'README.md'), '# fixture\n', 'utf8');

  const manifestPath = path.join(tempDir, 'suite.toml');
  await writeFile(
    manifestPath,
    `
[suite]
id = "stability-6"

[runtime]
reasoning_effort = "medium"
thinking = false
web_search_mode = "fixed"

[[fixtures]]
id = "tiny-app"
type = "template"
path = "./fixtures/tiny-app"

[[cases]]
id = "A1"
bucket = "A"
fixture = "tiny-app"
profile = "backend"
prompt = "/write note.txt :: hello"
`,
    'utf8'
  );

  const first = await runEvalSuite({
    manifestPath,
    runId: 'run-2026-04-09T03-00-00-000Z-aaaaaa'
  });
  const second = await runEvalSuite({
    manifestPath,
    runId: 'run-2026-04-09T03-00-01-000Z-bbbbbb'
  });
  const batch = await createEvalRunBatchRecord({
    suiteId: first.suiteId,
    manifestPath,
    runIds: [first.runId, second.runId]
  });

  const outputDir = path.join(tempDir, 'packs');
  const pack = await createEvalReviewPack({
    latestBatch: true,
    outputDir
  });

  assert.equal(pack.kind, 'batch');
  assert.equal(pack.batchId, batch.batchId);
  assert.deepEqual(pack.runIds, [first.runId, second.runId]);
  await assert.doesNotReject(() => access(pack.zipPath));
  assert.ok(pack.includedFiles.includes(path.join('batches', `${batch.batchId}.json`)));
  assert.ok(pack.includedFiles.includes(path.join(first.runId, 'manifest.lock.json')));
  assert.ok(pack.includedFiles.includes(path.join(second.runId, 'score-sheet.csv')));
  assert.ok(
    pack.includedFiles.includes(path.join(first.runId, 'A1', 'artifacts', 'session.md'))
  );
  assert.ok(!pack.includedFiles.some((entry) => entry.includes('workspace')));
});
