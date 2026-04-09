import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { parseEvalManifest } from '../src/evals/manifest-parse.js';
import { cleanupDir, createTempDir } from '../test-support/helpers.js';

test('parseEvalManifest treats model = \"default\" as unset for compatibility', async (t) => {
  const tempDir = await createTempDir('h2-eval-runtime-');
  t.after(async () => cleanupDir(tempDir));

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
model = "default"
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

  const parsed = await parseEvalManifest(manifestPath);
  assert.equal(parsed.manifest.runtime.model, undefined);
});

test('parseEvalManifest reads context_window_tokens for compaction stress stages', async (t) => {
  const tempDir = await createTempDir('h2-eval-runtime-context-');
  t.after(async () => cleanupDir(tempDir));

  const fixtureDir = path.join(tempDir, 'fixtures', 'tiny-app');
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(path.join(fixtureDir, 'README.md'), '# fixture\n', 'utf8');
  const manifestPath = path.join(tempDir, 'suite.toml');
  await writeFile(
    manifestPath,
    `
[suite]
id = "stage3b"

[runtime]
reasoning_effort = "medium"
thinking = false
web_search_mode = "fixed"
context_window_tokens = 75000

[[fixtures]]
id = "tiny-app"
type = "template"
path = "./fixtures/tiny-app"

[[cases]]
id = "L1"
bucket = "C"
fixture = "tiny-app"
profile = "long"
prompt = "/read README.md"
`,
    'utf8'
  );

  const parsed = await parseEvalManifest(manifestPath);
  assert.equal(parsed.manifest.runtime.contextWindowTokens, 75000);
});
