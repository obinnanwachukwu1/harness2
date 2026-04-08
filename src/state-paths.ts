import os from 'node:os';
import path from 'node:path';

export function getGlobalH2Dir(): string {
  return process.env.H2_HOME || path.join(os.homedir(), '.h2');
}

export function getGlobalAuthDbPath(): string {
  return process.env.H2_AUTH_DB_PATH || path.join(getGlobalH2Dir(), 'auth.sqlite');
}

export function getRepoStateDir(cwd: string): string {
  return path.join(cwd, '.h2');
}

export function getRepoNotebookPath(cwd: string): string {
  return path.join(getRepoStateDir(cwd), 'notebook.sqlite');
}

export function describeStatePaths(cwd: string): Array<{ label: string; path: string }> {
  return [
    { label: 'repo state dir', path: getRepoStateDir(cwd) },
    { label: 'repo notebook', path: getRepoNotebookPath(cwd) },
    { label: 'legacy repo state dir', path: path.join(cwd, '.harness2') },
    { label: 'global h2 home', path: getGlobalH2Dir() },
    { label: 'global auth db', path: getGlobalAuthDbPath() }
  ];
}
