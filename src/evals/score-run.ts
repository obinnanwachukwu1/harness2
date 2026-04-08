import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import type {
  EvalAutoScore,
  EvalCaseDefinition,
  EvalSuiteManifest,
  EvalSuiteRunResult
} from './manifest-types.js';
import { buildAutoScore } from './scoring.js';
import type { ExperimentRecord, ModelHistoryItem, StudyDebtRecord } from '../types.js';

export interface EvalScoreRunResult {
  runDir: string;
  scoreSheetCsvPath: string;
  scoreSheetJsonPath: string;
  scores: EvalAutoScore[];
}

export async function scoreEvalRun(runDir: string): Promise<EvalScoreRunResult> {
  const summaryPath = path.join(runDir, 'suite-summary.json');
  const manifestPath = path.join(runDir, 'manifest.lock.json');
  const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as EvalSuiteRunResult;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as EvalSuiteManifest;

  const scores: EvalAutoScore[] = [];
  for (const caseResult of summary.cases) {
    const caseDefinition = manifest.cases.find((entry) => entry.id === caseResult.caseId);
    if (!caseDefinition) {
      throw new Error(`Missing case definition for ${caseResult.caseId} in ${manifestPath}.`);
    }

    const modelHistory = await readJson<ModelHistoryItem[]>(caseResult.artifacts.modelHistoryJsonPath);
    const questions = await readJson<StudyDebtRecord[]>(caseResult.artifacts.questionsJsonPath);
    const experiments = await readJson<ExperimentRecord[]>(caseResult.artifacts.experimentsJsonPath);
    const score = buildAutoScore(
      caseDefinition as EvalCaseDefinition,
      modelHistory,
      questions,
      experiments,
      caseResult.clarificationFallbackUsed
    );
    scores.push(score);
    await writeFile(caseResult.artifacts.autoScorePath, JSON.stringify(score, null, 2), 'utf8');
  }

  const scoreSheetCsvPath = path.join(runDir, 'score-sheet.csv');
  const scoreSheetJsonPath = path.join(runDir, 'score-sheet.json');
  await writeFile(scoreSheetCsvPath, renderScoreCsv(scores), 'utf8');
  await writeFile(scoreSheetJsonPath, JSON.stringify(scores, null, 2), 'utf8');
  return {
    runDir,
    scoreSheetCsvPath,
    scoreSheetJsonPath,
    scores
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

function renderScoreCsv(scores: EvalAutoScore[]): string {
  const headers = [
    'test_id',
    'question_expected',
    'question_actual',
    'question_quality',
    'experiment_expected',
    'experiment_actual',
    'local_pass_before_experiment',
    'experiment_hypothesis_falsifiable',
    'duplicate_inline_probing_after_spawn',
    'silent_contract_choice',
    'unnecessary_clarification',
    'final_resolution_mode',
    'overall',
    'hard_fail_reasons',
    'notes'
  ];
  const rows = [headers.join(',')];
  for (const score of scores) {
    rows.push(
      [
        score.testId,
        stringifyNullable(score.questionExpected),
        String(score.questionActual),
        stringifyNullable(score.questionQuality),
        stringifyNullable(score.experimentExpected),
        String(score.experimentActual),
        score.localPassBeforeExperiment,
        score.experimentHypothesisFalsifiable,
        score.duplicateInlineProbingAfterSpawn,
        score.silentContractChoice,
        score.clarificationFallbackUsed,
        score.finalResolutionMode,
        score.overall,
        score.hardFailReasons.join(' | '),
        score.notes.join(' | ')
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return `${rows.join('\n')}\n`;
}

function stringifyNullable(value: boolean | number | null): string {
  return value === null ? '' : String(value);
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
