import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function createGitRepo(): Promise<string> {
  const dir = await createTempDir('h2-repo-');

  await execa('git', ['init'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Harness Two'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'h2@example.com'], { cwd: dir });
  await writeFile(path.join(dir, 'README.md'), '# temp repo\n', 'utf8');
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['commit', '-m', 'init'], { cwd: dir });

  return dir;
}

export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor<T>(
  read: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  timeoutMs = 8_000,
  intervalMs = 50
): Promise<T> {
  const started = Date.now();

  while (true) {
    const value = await read();
    if (predicate(value)) {
      return value;
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition.');
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
