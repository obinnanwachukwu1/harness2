import type {
  EvalAutoScore,
  EvalCaseDefinition,
  EvalResolutionMode
} from './manifest-types.js';
import type { ExperimentRecord, ModelHistoryItem, StudyDebtRecord } from '../types.js';

export function buildAutoScore(
  testCase: EvalCaseDefinition,
  modelHistory: ModelHistoryItem[],
  studyDebts: StudyDebtRecord[],
  experiments: ExperimentRecord[],
  clarificationFallbackUsed: boolean
): EvalAutoScore {
  const questionActual = studyDebts.length > 0;
  const experimentCount = experiments.length;
  const experimentActual: 0 | 1 | '2+' =
    experimentCount <= 0 ? 0 : experimentCount === 1 ? 1 : '2+';
  const finalResolutionMode = readFinalResolutionMode(studyDebts);
  const localPassBeforeExperiment = readLocalPassBeforeExperiment(modelHistory);
  const experimentHypothesisFalsifiable = readExperimentHypothesisFalsifiable(modelHistory);
  const duplicateInlineProbingAfterSpawn = readDuplicateInlineProbingAfterSpawn(modelHistory);
  const silentContractChoice = readSilentContractChoice(testCase, studyDebts);
  const hardFailReasons = readHardFailReasons({
    testCase,
    questionActual,
    experimentCount,
    localPassBeforeExperiment,
    duplicateInlineProbingAfterSpawn,
    modelHistory
  });
  const notes: string[] = [];

  if (testCase.questionExpected !== undefined && testCase.questionExpected !== questionActual) {
    notes.push(
      `Expected question=${String(testCase.questionExpected)} but saw question=${String(questionActual)}.`
    );
  }
  if (
    testCase.experimentExpected !== undefined &&
    testCase.experimentExpected !== (experimentCount > 0)
  ) {
    notes.push(
      `Expected experiment=${String(testCase.experimentExpected)} but saw experiment=${String(experimentCount > 0)}.`
    );
  }
  if (hardFailReasons.length > 0) {
    notes.push(...hardFailReasons);
  }

  return {
    testId: testCase.id,
    questionExpected: testCase.questionExpected ?? null,
    questionActual,
    questionQuality: null,
    experimentExpected: testCase.experimentExpected ?? null,
    experimentActual,
    localPassBeforeExperiment,
    experimentHypothesisFalsifiable,
    duplicateInlineProbingAfterSpawn,
    silentContractChoice,
    finalResolutionMode,
    clarificationFallbackUsed: clarificationFallbackUsed ? 'yes' : 'no',
    overall:
      hardFailReasons.length > 0 ? 'hard fail' : clarificationFallbackUsed ? 'soft fail' : 'pass',
    hardFailReasons,
    notes
  };
}

function readLocalPassBeforeExperiment(
  modelHistory: ModelHistoryItem[]
): 'yes' | 'no' | 'n/a' {
  const firstSpawnIndex = modelHistory.findIndex(
    (item) => item.type === 'function_call' && item.name === 'spawn_experiment'
  );
  if (firstSpawnIndex === -1) {
    return 'n/a';
  }

  const priorCalls = modelHistory.slice(0, firstSpawnIndex).filter(isFunctionCall);
  return priorCalls.some((item) =>
    ['read', 'ls', 'glob', 'rg', 'grep', 'exec_command'].includes(item.name)
  )
    ? 'yes'
    : 'no';
}

function readExperimentHypothesisFalsifiable(
  modelHistory: ModelHistoryItem[]
): 'yes' | 'no' | 'n/a' {
  const spawnCalls = modelHistory.filter(isSpawnExperimentCall);
  if (spawnCalls.length === 0) {
    return 'n/a';
  }

  return spawnCalls.every((item) => {
    const args = safeParseArguments(item.arguments);
    return hasNonEmptyString(args.hypothesis) && hasNonEmptyString(args.residualUncertainty);
  })
    ? 'yes'
    : 'no';
}

function readDuplicateInlineProbingAfterSpawn(
  modelHistory: ModelHistoryItem[]
): 'yes' | 'no' | 'n/a' {
  const firstSpawnIndex = modelHistory.findIndex(
    (item) => item.type === 'function_call' && item.name === 'spawn_experiment'
  );
  if (firstSpawnIndex === -1) {
    return 'n/a';
  }

  const tailCalls = modelHistory.slice(firstSpawnIndex + 1).filter(isFunctionCall);
  const firstExperimentReadIndex = tailCalls.findIndex((item) =>
    ['wait_experiment', 'read_experiment', 'resolve_experiment'].includes(item.name)
  );
  const probeWindow =
    firstExperimentReadIndex === -1 ? tailCalls : tailCalls.slice(0, firstExperimentReadIndex);

  return probeWindow.some((item) =>
    ['read', 'ls', 'glob', 'rg', 'grep', 'exec_command', 'search_experiments', 'web_search'].includes(
      item.name
    )
  )
    ? 'yes'
    : 'no';
}

function readSilentContractChoice(
  testCase: EvalCaseDefinition,
  studyDebts: StudyDebtRecord[]
): 'yes' | 'no' | 'n/a' {
  if (testCase.bucket !== 'B') {
    return 'n/a';
  }
  return studyDebts.length > 0 ? 'no' : 'yes';
}

function readHardFailReasons(input: {
  testCase: EvalCaseDefinition;
  questionActual: boolean;
  experimentCount: number;
  localPassBeforeExperiment: 'yes' | 'no' | 'n/a';
  duplicateInlineProbingAfterSpawn: 'yes' | 'no' | 'n/a';
  modelHistory: ModelHistoryItem[];
}): string[] {
  const failures: string[] = [];

  if (input.testCase.bucket === 'A') {
    if (input.questionActual) {
      failures.push('Bucket A opened a question.');
    }
    if (input.experimentCount > 0) {
      failures.push('Bucket A spawned an experiment.');
    }
  }

  if (input.testCase.bucket === 'B' && !input.questionActual) {
    failures.push('Bucket B made no explicit question visible.');
  }

  if (input.testCase.bucket === 'C') {
    if (!input.questionActual) {
      failures.push('Bucket C did not open a question.');
    }
    if (input.experimentCount === 0) {
      failures.push('Bucket C did not produce an experiment.');
    }
    if (input.localPassBeforeExperiment === 'no') {
      failures.push('Bucket C spawned without a local evidence pass.');
    }
  }

  if (input.duplicateInlineProbingAfterSpawn === 'yes') {
    failures.push('Inline probing continued after experiment spawn.');
  }

  if (hasSearchExperimentsBeforeQuestion(input.modelHistory)) {
    failures.push('search_experiments was used before a question was opened.');
  }

  return failures;
}

function readFinalResolutionMode(studyDebts: StudyDebtRecord[]): EvalResolutionMode {
  const lastResolved = [...studyDebts]
    .reverse()
    .find((question) => question.status === 'closed' && question.resolution);
  return (lastResolved?.resolution as EvalResolutionMode | undefined) ?? 'none';
}

function hasSearchExperimentsBeforeQuestion(modelHistory: ModelHistoryItem[]): boolean {
  let openedQuestion = false;
  for (const item of modelHistory) {
    if (!isFunctionCall(item)) {
      continue;
    }
    if (item.name === 'open_question' || item.name === 'open_study_debt') {
      openedQuestion = true;
      continue;
    }
    if (!openedQuestion && item.name === 'search_experiments') {
      return true;
    }
  }
  return false;
}

function isFunctionCall(
  item: ModelHistoryItem
): item is Extract<ModelHistoryItem, { type: 'function_call' }> {
  return item.type === 'function_call';
}

function isSpawnExperimentCall(
  item: ModelHistoryItem
): item is Extract<ModelHistoryItem, { type: 'function_call' }> {
  return item.type === 'function_call' && item.name === 'spawn_experiment';
}

function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
