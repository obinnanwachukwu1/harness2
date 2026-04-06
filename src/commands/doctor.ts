import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';

import type { DoctorCheck, DoctorReport } from '../types.js';

export async function runDoctor(cwd: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

  checks.push({
    label: 'node',
    ok: nodeMajor >= 22,
    detail: `Node ${process.version} (need 22+ for node:sqlite).`
  });

  try {
    await import('node:sqlite');
    checks.push({
      label: 'sqlite',
      ok: true,
      detail: 'node:sqlite is available.'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      label: 'sqlite',
      ok: false,
      detail: message
    });
  }

  const gitRepo = await checkGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  checks.push({
    label: 'git repo',
    ok: gitRepo.ok,
    detail: gitRepo.detail
  });

  if (gitRepo.ok) {
    const commit = await checkGit(cwd, ['rev-parse', 'HEAD']);
    checks.push({
      label: 'git commit',
      ok: commit.ok,
      detail: commit.detail
    });

    const worktree = await checkGit(cwd, ['worktree', 'list']);
    checks.push({
      label: 'git worktree',
      ok: worktree.ok,
      detail: worktree.detail
    });
  }

  try {
    await mkdir(path.join(cwd, '.h2'), { recursive: true });
    checks.push({
      label: 'state dir',
      ok: true,
      detail: 'State directory is writable.'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      label: 'state dir',
      ok: false,
      detail: message
    });
  }

  return {
    cwd,
    healthy: checks.every((check) => check.ok),
    checks
  };
}

async function checkGit(cwd: string, args: string[]): Promise<{ ok: boolean; detail: string }> {
  const result = await execa('git', args, {
    cwd,
    reject: false
  });

  if (result.exitCode === 0) {
    return {
      ok: true,
      detail: result.stdout.trim() || 'ok'
    };
  }

  return {
    ok: false,
    detail: result.stderr.trim() || `git ${args.join(' ')} exited ${result.exitCode}`
  };
}
