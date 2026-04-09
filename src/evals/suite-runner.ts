import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { parseEvalManifest } from './manifest-parse.js';
import { runEvalCase } from './case-runner.js';
import { scoreEvalRun } from './score-run.js';
import type { EvalRunRequest, EvalRuntimeConfig, EvalSuiteRunResult } from './manifest-types.js';
import { createSessionId, nowIso } from '../lib/utils.js';
import { getGlobalH2Dir } from '../state-paths.js';

export async function runEvalSuite(request: EvalRunRequest): Promise<EvalSuiteRunResult> {
  const parsed = await parseEvalManifest(request.manifestPath);
  const runtime = mergeRuntime(parsed.manifest.runtime, request.runtimeOverride);
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
  const effectiveManifest = {
    ...parsed.manifest,
    runtime
  };
  await writeFile(lockedManifestPath, JSON.stringify(effectiveManifest, null, 2), 'utf8');
  const effectiveParallelism = normalizeParallelism(request.parallelism ?? runtime.parallelism);
  if (runtime.contextWindowTokens && effectiveParallelism > 1) {
    throw new Error(
      'context_window_tokens is only supported with eval parallelism = 1 because the current implementation uses a process-wide override.'
    );
  }
  request.onProgress?.({
    type: 'suite_started',
    runId,
    suiteId: parsed.manifest.suite.id,
    totalCases: selectedCases.length,
    runRoot
  });

  const fixtureById = new Map(parsed.manifest.fixtures.map((entry) => [entry.id, entry]));
  const plannedCases = selectedCases.map((testCase, index) => {
    const fixture = fixtureById.get(testCase.fixture);
    if (!fixture) {
      throw new Error(`Case ${testCase.id} references unknown fixture ${testCase.fixture}.`);
    }
    return { index, testCase, fixture };
  });
  const results = await runCasesWithConcurrency(
    plannedCases,
    effectiveParallelism,
    async (planned) => {
      request.onProgress?.({
        type: 'case_started',
        runId,
        suiteId: parsed.manifest.suite.id,
        caseId: planned.testCase.id,
        fixtureId: planned.fixture.id,
        profile: planned.testCase.profile,
        index: planned.index + 1,
        totalCases: selectedCases.length
      });

      const caseResult = await runEvalCase({
        runId,
        caseDefinition: planned.testCase,
        fixture: planned.fixture,
        runRoot,
        runtime,
        clarification: parsed.manifest.clarification
      });
      request.onProgress?.({
        type: 'case_completed',
        runId,
        suiteId: parsed.manifest.suite.id,
        caseId: planned.testCase.id,
        fixtureId: planned.fixture.id,
        profile: planned.testCase.profile,
        index: planned.index + 1,
        totalCases: selectedCases.length,
        overall: caseResult.autoScore.overall,
        questionActual: caseResult.autoScore.questionActual,
        experimentActual: caseResult.autoScore.experimentActual
      });
      return caseResult;
    }
  );

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

function mergeRuntime(
  base: EvalRuntimeConfig,
  override?: Partial<EvalRuntimeConfig>
): EvalRuntimeConfig {
  return {
    ...base,
    ...override
  };
}

function createRunId(): string {
  const stamp = nowIso().replace(/[:.]/g, '-');
  return `run-${stamp}-${createSessionId().slice(-6)}`;
}

function normalizeParallelism(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.floor(value));
}

async function runCasesWithConcurrency<TCase, TResult>(
  cases: TCase[],
  parallelism: number,
  worker: (entry: TCase) => Promise<TResult>
): Promise<TResult[]> {
  if (cases.length === 0) {
    return [];
  }

  const results = new Array<TResult>(cases.length);
  let nextIndex = 0;
  let firstError: unknown = null;

  const runWorker = async (): Promise<void> => {
    while (true) {
      if (firstError) {
        return;
      }

      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= cases.length) {
        return;
      }

      try {
        results[currentIndex] = await worker(cases[currentIndex]!);
      } catch (error) {
        firstError ??= error;
        return;
      }
    }
  };

  const workerCount = Math.min(parallelism, cases.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  if (firstError) {
    throw firstError;
  }

  return results;
}
