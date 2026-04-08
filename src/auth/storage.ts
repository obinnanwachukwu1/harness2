import { Notebook } from '../storage/notebook.js';
import { getGlobalAuthDbPath } from '../state-paths.js';

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
