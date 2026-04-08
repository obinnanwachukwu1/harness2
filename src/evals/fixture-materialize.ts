import path from 'node:path';
import { cp, mkdir } from 'node:fs/promises';

import { execa } from 'execa';

import type {
  EvalFixtureDefinition,
  MaterializedFixture
} from './manifest-types.js';

export async function materializeFixture(
  fixture: EvalFixtureDefinition,
  workspacePath: string
): Promise<MaterializedFixture> {
  await mkdir(path.dirname(workspacePath), { recursive: true });

  if (fixture.type === 'template') {
    await cp(fixture.path, workspacePath, {
      recursive: true
    });
    await initializeGitRepository(workspacePath, 'fixture snapshot');
    if (fixture.setupCommand) {
      await execaCommandChecked(fixture.setupCommand, workspacePath);
    }
    return {
      fixtureId: fixture.id,
      workspacePath,
      sourcePath: fixture.path,
      sourceRef: null,
      envFilePath: null,
      envExamplePath: null
    };
  }

  await execa('git', ['clone', '--quiet', '--no-hardlinks', fixture.path, workspacePath], {
    cwd: path.dirname(workspacePath)
  });
  const ref = fixture.ref ?? 'HEAD';
  await execa('git', ['checkout', '--quiet', '--detach', ref], {
    cwd: workspacePath
  });
  if (fixture.setupCommand) {
    await execaCommandChecked(fixture.setupCommand, workspacePath);
  }
  return {
    fixtureId: fixture.id,
    workspacePath,
    sourcePath: fixture.path,
    sourceRef: ref,
    envFilePath: null,
    envExamplePath: null
  };
}

async function initializeGitRepository(workspacePath: string, message: string): Promise<void> {
  await execa('git', ['init'], { cwd: workspacePath });
  await execa('git', ['config', 'user.name', 'Harness Two'], { cwd: workspacePath });
  await execa('git', ['config', 'user.email', 'h2@example.com'], { cwd: workspacePath });
  await execa('git', ['add', '.'], { cwd: workspacePath });
  await execa('git', ['commit', '-m', message], { cwd: workspacePath });
}

async function execaCommandChecked(command: string, cwd: string): Promise<void> {
  const { execaCommand } = await import('execa');
  const result = await execaCommand(command, {
    cwd,
    reject: false,
    shell: true
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Fixture setup command failed in ${cwd}: ${result.stderr || result.stdout || command}`
    );
  }
}
