import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export interface MaterializeEnvOptions {
  envSource?: string;
  writeEnvFile?: string;
  writeEnvExample?: string;
}

export interface MaterializeEnvResult {
  envFilePath?: string | null;
  envExamplePath?: string | null;
  exampleContents?: string | null;
}

export async function materializeEnvFiles(
  workspacePath: string,
  options: MaterializeEnvOptions
): Promise<MaterializeEnvResult> {
  const resolvedSource = options.envSource ? expandUserPath(options.envSource) : null;
  const envContents = resolvedSource ? await readFile(resolvedSource, 'utf8') : null;

  let envFilePath: string | null = null;
  if (envContents !== null && options.writeEnvFile) {
    envFilePath = path.join(workspacePath, options.writeEnvFile);
    await mkdir(path.dirname(envFilePath), { recursive: true });
    await writeFile(envFilePath, envContents, 'utf8');
  }

  let envExamplePath: string | null = null;
  let exampleContents: string | null = null;
  if (envContents !== null && options.writeEnvExample) {
    envExamplePath = path.join(workspacePath, options.writeEnvExample);
    exampleContents = buildEnvExample(envContents);
    await mkdir(path.dirname(envExamplePath), { recursive: true });
    await writeFile(envExamplePath, exampleContents, 'utf8');
  }

  return {
    envFilePath,
    envExamplePath,
    exampleContents
  };
}

export function buildEnvExample(envContents: string): string {
  const output: string[] = [];

  for (const line of envContents.split(/\r?\n/)) {
    if (!line.trim()) {
      output.push('');
      continue;
    }
    if (line.trimStart().startsWith('#')) {
      output.push(line);
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      output.push(line);
      continue;
    }

    const key = match[1];
    const rawValue = match[2] ?? '';
    output.push(isLikelySecretKey(key) ? `${key}=` : `${key}=${redactNonSecretValue(rawValue)}`);
  }

  return output.join('\n');
}

function isLikelySecretKey(key: string): boolean {
  return /(KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE|AUTH)/i.test(key);
}

function redactNonSecretValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return '';
  }
  if (
    trimmed === 'true' ||
    trimmed === 'false' ||
    /^-?\d+(\.\d+)?$/.test(trimmed) ||
    /^https?:\/\//.test(trimmed) ||
    /^[A-Za-z0-9._:/-]+$/.test(trimmed)
  ) {
    return trimmed;
  }
  return '';
}

export function expandUserPath(targetPath: string): string {
  if (targetPath === '~') {
    return os.homedir();
  }
  if (targetPath.startsWith('~/')) {
    return path.join(os.homedir(), targetPath.slice(2));
  }
  return targetPath;
}
