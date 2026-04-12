import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { execa } from 'execa';

import { ensureGitWorkspaceForHarbor } from '../src/integrations/harbor/run.js';
import { cleanupDir, createTempDir } from '../test-support/helpers.js';

test('ensureGitWorkspaceForHarbor initializes a repo with an initial commit when missing', async (t) => {
  const tempDir = await createTempDir('h2-harbor-git-bootstrap-');
  t.after(async () => cleanupDir(tempDir));

  await mkdir(path.join(tempDir, 'app'), { recursive: true });
  await writeFile(path.join(tempDir, 'app', 'page.tsx'), 'export default function Page() { return null; }\n', 'utf8');

  const result = await ensureGitWorkspaceForHarbor(tempDir);

  assert.equal(result.bootstrapped, true);
  assert.equal(result.reason, 'initialized_repository');

  const insideRepo = await execa('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: tempDir
  });
  assert.equal(insideRepo.stdout.trim(), 'true');

  const head = await execa('git', ['rev-parse', 'HEAD'], {
    cwd: tempDir
  });
  assert.match(head.stdout.trim(), /^[0-9a-f]{40}$/);
});

test('ensureGitWorkspaceForHarbor creates the initial commit when a repo exists without HEAD', async (t) => {
  const tempDir = await createTempDir('h2-harbor-git-headless-');
  t.after(async () => cleanupDir(tempDir));

  await writeFile(path.join(tempDir, 'README.md'), '# smoke\n', 'utf8');
  await execa('git', ['init'], { cwd: tempDir });

  const result = await ensureGitWorkspaceForHarbor(tempDir);

  assert.equal(result.bootstrapped, true);
  assert.equal(result.reason, 'created_initial_commit');

  const head = await execa('git', ['rev-parse', 'HEAD'], {
    cwd: tempDir
  });
  assert.match(head.stdout.trim(), /^[0-9a-f]{40}$/);
});

test('ensureGitWorkspaceForHarbor leaves existing repos with commits untouched', async (t) => {
  const tempDir = await createTempDir('h2-harbor-git-existing-');
  t.after(async () => cleanupDir(tempDir));

  await writeFile(path.join(tempDir, 'README.md'), '# smoke\n', 'utf8');
  await execa('git', ['init'], { cwd: tempDir });
  await execa('git', ['config', 'user.name', 'Harness Two'], { cwd: tempDir });
  await execa('git', ['config', 'user.email', 'h2@example.com'], { cwd: tempDir });
  await execa('git', ['add', '.'], { cwd: tempDir });
  await execa('git', ['commit', '-m', 'init'], { cwd: tempDir });
  const beforeHead = await execa('git', ['rev-parse', 'HEAD'], { cwd: tempDir });

  const result = await ensureGitWorkspaceForHarbor(tempDir);

  assert.equal(result.bootstrapped, false);
  assert.equal(result.reason, 'already_initialized');

  const afterHead = await execa('git', ['rev-parse', 'HEAD'], { cwd: tempDir });
  assert.equal(afterHead.stdout.trim(), beforeHead.stdout.trim());
});
