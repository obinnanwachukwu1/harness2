import os from 'node:os';
import path from 'node:path';

import { Notebook } from '../storage/notebook.js';

export function getGlobalH2Dir(): string {
  return process.env.H2_HOME || path.join(os.homedir(), '.h2');
}

export function getGlobalAuthDbPath(): string {
  return process.env.H2_AUTH_DB_PATH || path.join(getGlobalH2Dir(), 'auth.sqlite');
}

export function openGlobalAuthNotebook(): Notebook {
  return new Notebook(getGlobalAuthDbPath());
}

export function migrateLegacyRepoLocalAuth(
  repoNotebook: Notebook,
  globalAuthNotebook: Notebook
): boolean {
  const existingGlobal = globalAuthNotebook.getOpenAICodexAuth();
  if (existingGlobal) {
    return false;
  }

  const legacyLocal = repoNotebook.getOpenAICodexAuth();
  if (!legacyLocal) {
    return false;
  }

  globalAuthNotebook.upsertOpenAICodexAuth(legacyLocal);
  repoNotebook.deleteOpenAICodexAuth();
  return true;
}
