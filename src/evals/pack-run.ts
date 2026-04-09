import os from 'node:os';
import path from 'node:path';
import { access, mkdir, readdir, rm } from 'node:fs/promises';

import { execa } from 'execa';

import { getGlobalH2Dir } from '../state-paths.js';

const TOP_LEVEL_REVIEW_FILES = [
  'manifest.lock.json',
  'suite-summary.json',
  'score-sheet.csv',
  'score-sheet.json'
] as const;

const CASE_REVIEW_FILES = [
  'manifest.case.json',
  path.join('artifacts', 'session.md'),
  path.join('artifacts', 'transcript.json'),
  path.join('artifacts', 'questions.json'),
  path.join('artifacts', 'experiments.json'),
  path.join('artifacts', 'score.auto.json'),
  path.join('artifacts', 'diff.patch'),
  path.join('artifacts', 'git-status.txt'),
  path.join('artifacts', 'model-history.json'),
  path.join('artifacts', 'runtime.json')
] as const;

export interface EvalReviewPackResult {
  runId: string;
  runDir: string;
  zipPath: string;
  includedFiles: string[];
}

export async function createEvalReviewPack(input: {
  selector?: string;
  outputDir?: string;
} = {}): Promise<EvalReviewPackResult> {
  const runDir = await resolveEvalRunDir(input.selector);
  const runId = path.basename(runDir);
  const outputDir = input.outputDir ?? path.join(os.homedir(), 'Desktop');
  await mkdir(outputDir, { recursive: true });

  const includedFiles = await collectReviewPackFiles(runDir);
  if (includedFiles.length === 0) {
    throw new Error(`No review-pack files were found in ${runDir}.`);
  }

  const zipPath = path.join(outputDir, `${runId}-review-pack.zip`);
  await rm(zipPath, { force: true });
  await execa('zip', ['-q', '-@', zipPath], {
    cwd: runDir,
    input: `${includedFiles.join('\n')}\n`
  });

  return {
    runId,
    runDir,
    zipPath,
    includedFiles
  };
}

async function resolveEvalRunDir(selector?: string): Promise<string> {
  if (selector) {
    const explicitPath = path.resolve(selector);
    if (await pathExists(explicitPath)) {
      return explicitPath;
    }
  }

  const evalRoot = path.join(getGlobalH2Dir(), 'evals');
  const entries = await readdir(evalRoot, { withFileTypes: true });
  const runDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('run-'))
    .map((entry) => path.join(evalRoot, entry.name));

  if (runDirs.length === 0) {
    throw new Error(`No eval runs found under ${evalRoot}.`);
  }

  if (!selector) {
    return latestByBasename(runDirs);
  }

  const normalized = selector.trim();
  const exact = runDirs.find((runDir) => path.basename(runDir) === normalized);
  if (exact) {
    return exact;
  }

  const suffixMatches = runDirs.filter((runDir) => path.basename(runDir).endsWith(normalized));
  if (suffixMatches.length === 1) {
    return suffixMatches[0]!;
  }
  if (suffixMatches.length > 1) {
    throw new Error(
      `Run selector "${selector}" matched multiple eval runs: ${suffixMatches
        .map((runDir) => path.basename(runDir))
        .join(', ')}`
    );
  }

  throw new Error(`No eval run matched "${selector}".`);
}

async function collectReviewPackFiles(runDir: string): Promise<string[]> {
  const included = new Set<string>();

  for (const topLevelFile of TOP_LEVEL_REVIEW_FILES) {
    if (await pathExists(path.join(runDir, topLevelFile))) {
      included.add(topLevelFile);
    }
  }

  const entries = await readdir(runDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!/^[A-Z]\d+$/.test(entry.name)) {
      continue;
    }

    for (const relativeFile of CASE_REVIEW_FILES) {
      const relativePath = path.join(entry.name, relativeFile);
      if (await pathExists(path.join(runDir, relativePath))) {
        included.add(relativePath);
      }
    }
  }

  return [...included].sort();
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function latestByBasename(runDirs: string[]): string {
  return [...runDirs].sort((left, right) => path.basename(right).localeCompare(path.basename(left)))[0]!;
}
