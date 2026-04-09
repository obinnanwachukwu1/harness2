import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { parseEvalManifest } from '../src/evals/manifest-parse.js';
import { cleanupDir, createTempDir } from '../test-support/helpers.js';

test('parseEvalManifest normalizes fixture paths and nested followups', async (t) => {
  const tempDir = await createTempDir('h2-eval-manifest-');
  t.after(async () => cleanupDir(tempDir));

  const fixtureDir = path.join(tempDir, 'fixtures', 'empty-node');
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(path.join(fixtureDir, 'package.json'), '{"name":"fixture"}\n', 'utf8');
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
parallelism = 3
repeat_count = 5

[[fixtures]]
id = "empty-node"
type = "template"
path = "./fixtures/empty-node"
env_source = "~/.h2/eval-env/empty-node.env"
write_env_file = ".env"
write_env_example = ".env.example"

[[cases]]
id = "B1"
bucket = "B"
fixture = "empty-node"
profile = "existing"
prompt = "first prompt"
question_expected = true
experiment_expected = "optional"

[[cases.followups]]
after_turn = 1
prompt = "second prompt"
`,
    'utf8'
  );

  const parsed = await parseEvalManifest(manifestPath);
  assert.equal(parsed.manifest.fixtures[0]?.path, fixtureDir);
  assert.equal(parsed.manifest.runtime.model, undefined);
  assert.equal(parsed.manifest.runtime.parallelism, 3);
  assert.equal(parsed.manifest.runtime.repeatCount, 5);
  assert.equal(parsed.manifest.cases[0]?.followups.length, 1);
  assert.equal(parsed.manifest.cases[0]?.followups[0]?.afterTurn, 1);
  assert.equal(parsed.manifest.cases[0]?.followups[0]?.prompt, 'second prompt');
  assert.equal(parsed.manifest.cases[0]?.profile, 'existing');
  assert.equal(parsed.manifest.cases[0]?.experimentExpected, 'optional');
});
