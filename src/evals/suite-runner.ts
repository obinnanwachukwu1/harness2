import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { parseEvalManifest } from './manifest-parse.js';
import { runEvalCase } from './case-runner.js';
import { scoreEvalRun } from './score-run.js';
import type { EvalRunRequest, EvalSuiteRunResult } from './manifest-types.js';
import { createSessionId, nowIso } from '../lib/utils.js';
import { getGlobalH2Dir } from '../state-paths.js';

export async function runEvalSuite(request: EvalRunRequest): Promise<EvalSuiteRunResult> {
  const parsed = await parseEvalManifest(request.manifestPath);
  const selectedCases =
    request.selectedCaseIds && request.selectedCaseIds.length > 0
      ? parsed.manifest.cases.filter((entry) => request.selectedCaseIds!.includes(entry.id))
      : parsed.manifest.cases;
  if (selectedCases.length === 0) {
    throw new Error('No eval cases matched the requested selection.');
  }

  const runId = request.runId ?? createRunId();
  const runRoot = path.join(getGlobalH2Dir(), 'evals', runId);
  const startedAt = nowIso();
  await mkdir(runRoot, { recursive: true });
  const lockedManifestPath = path.join(runRoot, 'manifest.lock.json');
  await writeFile(lockedManifestPath, JSON.stringify(parsed.manifest, null, 2), 'utf8');

  const results = [];
  for (const testCase of selectedCases) {
    const fixture = parsed.manifest.fixtures.find((entry) => entry.id === testCase.fixture);
    if (!fixture) {
      throw new Error(`Case ${testCase.id} references unknown fixture ${testCase.fixture}.`);
    }

    results.push(
      await runEvalCase({
        runId,
        caseDefinition: testCase,
        fixture,
        runRoot,
        runtime: parsed.manifest.runtime,
        clarification: parsed.manifest.clarification
      })
    );
  }

  const output: EvalSuiteRunResult = {
    runId,
    suiteId: parsed.manifest.suite.id,
    manifestPath: parsed.manifestPath,
    lockedManifestPath,
    startedAt,
    completedAt: nowIso(),
    cases: results
  };
  await writeFile(path.join(runRoot, 'suite-summary.json'), JSON.stringify(output, null, 2), 'utf8');
  await scoreEvalRun(runRoot);
  return output;
}

function createRunId(): string {
  const stamp = nowIso().replace(/[:.]/g, '-');
  return `run-${stamp}-${createSessionId().slice(-6)}`;
}
