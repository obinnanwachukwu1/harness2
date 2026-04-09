import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAutoScore } from '../src/evals/scoring.js';
import type { EvalCaseDefinition } from '../src/evals/manifest-types.js';
import type { ExperimentRecord, ModelHistoryItem, StudyDebtRecord } from '../src/types.js';

test('buildAutoScore marks hard-fail structural issues for bucket C', () => {
  const testCase: EvalCaseDefinition = {
    id: 'C1',
    bucket: 'C',
    fixture: 'empty-node',
    profile: 'backend',
    prompt: 'probe runtime behavior',
    followups: [],
    reviewHints: [],
    questionExpected: true,
    experimentExpected: true
  };
  const modelHistory: ModelHistoryItem[] = [
    {
      type: 'function_call',
      call_id: 'call-1',
      name: 'spawn_experiment',
      arguments: JSON.stringify({
        hypothesis: 'single statement is sufficient',
        residualUncertainty: 'whether claim loop is safe'
      })
    },
    {
      type: 'function_call_output',
      call_id: 'call-1',
      output: '{}'
    },
    {
      type: 'function_call',
      call_id: 'call-2',
      name: 'read',
      arguments: JSON.stringify({ path: 'src/server.ts' })
    }
  ];
  const score = buildAutoScore(testCase, modelHistory, [], [] as ExperimentRecord[], false);

  assert.equal(score.overall, 'hard fail');
  assert.equal(score.questionActual, false);
  assert.equal(score.localPassBeforeExperiment, 'no');
  assert.equal(score.duplicateInlineProbingAfterSpawn, 'yes');
  assert.equal(score.webSearchActual, false);
  assert.equal(score.questionBeforeWebSearch, 'n/a');
  assert.ok(score.hardFailReasons.some((reason) => reason.includes('Bucket C did not open a question.')));
});

test('buildAutoScore marks silent contract choice for bucket B without a question', () => {
  const testCase: EvalCaseDefinition = {
    id: 'B1',
    bucket: 'B',
    fixture: 'run-harness2',
    profile: 'existing',
    prompt: 'add cancellation and replay',
    followups: [],
    reviewHints: [],
    questionExpected: true,
    experimentExpected: false
  };
  const modelHistory: ModelHistoryItem[] = [];
  const score = buildAutoScore(testCase, modelHistory, [] as StudyDebtRecord[], [] as ExperimentRecord[], false);

  assert.equal(score.silentContractChoice, 'yes');
  assert.equal(score.overall, 'hard fail');
});

test('buildAutoScore tracks web search ordering when docs shape the path', () => {
  const testCase: EvalCaseDefinition = {
    id: 'C2',
    bucket: 'C',
    fixture: 'next-app-router',
    profile: 'ai/full-stack',
    prompt: 'verify docs and runtime',
    followups: [],
    reviewHints: [],
    questionExpected: true,
    experimentExpected: true,
    webSearchExpected: 'yes'
  };
  const modelHistory: ModelHistoryItem[] = [
    {
      type: 'function_call',
      call_id: 'call-1',
      name: 'web_search',
      arguments: JSON.stringify({ query: 'responses api streaming docs' })
    },
    {
      type: 'function_call_output',
      call_id: 'call-1',
      output: '{}'
    }
  ];

  const score = buildAutoScore(testCase, modelHistory, [] as StudyDebtRecord[], [] as ExperimentRecord[], false);
  assert.equal(score.webSearchActual, true);
  assert.equal(score.questionBeforeWebSearch, 'no');
  assert.ok(
    score.hardFailReasons.some((reason) => reason.includes('Bucket C used web search before naming the question.'))
  );
});

test('buildAutoScore counts provider-executed web search as web search activity', () => {
  const testCase: EvalCaseDefinition = {
    id: 'C1',
    bucket: 'C',
    fixture: 'next-app-router',
    profile: 'ai/full-stack',
    prompt: 'verify docs and runtime',
    followups: [],
    reviewHints: [],
    questionExpected: true,
    experimentExpected: true,
    webSearchExpected: 'yes'
  };
  const modelHistory: ModelHistoryItem[] = [
    {
      type: 'message',
      role: 'developer',
      content: 'Built-in web_search executed.\nquery: responses api streaming'
    }
  ];

  const score = buildAutoScore(testCase, modelHistory, [] as StudyDebtRecord[], [] as ExperimentRecord[], false);
  assert.equal(score.webSearchActual, true);
  assert.equal(score.questionBeforeWebSearch, 'no');
});

test('buildAutoScore ignores blocked inline probing after spawn when the engine rejected it', () => {
  const testCase: EvalCaseDefinition = {
    id: 'C4',
    bucket: 'C',
    fixture: 'node-minimal',
    profile: 'backend/durability',
    prompt: 'test durability strategy',
    followups: [],
    reviewHints: [],
    questionExpected: true,
    experimentExpected: true
  };
  const modelHistory: ModelHistoryItem[] = [
    {
      type: 'function_call',
      call_id: 'call-1',
      name: 'spawn_experiment',
      arguments: JSON.stringify({
        questionId: 'question-1',
        hypothesis: 'rename avoids torn reads',
        residualUncertainty: 'whether inline writes stay atomic'
      })
    },
    {
      type: 'function_call_output',
      call_id: 'call-1',
      output: JSON.stringify({ ok: true, experimentId: 'exp-1' })
    },
    {
      type: 'function_call',
      call_id: 'call-2',
      name: 'exec_command',
      arguments: JSON.stringify({ command: 'node probe.js' })
    },
    {
      type: 'function_call_output',
      call_id: 'call-2',
      output: JSON.stringify({
        ok: false,
        error: {
          message:
            'An active linked experiment already owns this evidence path for exec_command.'
        }
      })
    },
    {
      type: 'function_call',
      call_id: 'call-3',
      name: 'wait_experiment',
      arguments: JSON.stringify({ experimentId: 'exp-1' })
    }
  ];
  const studyDebts: StudyDebtRecord[] = [
    {
      id: 'question-1',
      sessionId: 'session-1',
      status: 'open',
      summary: 'durability is unproven',
      whyItMatters: 'it changes the persistence strategy',
      kind: 'runtime',
      affectedPaths: ['src/tracker.js'],
      recommendedStudy: null,
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
      resolution: null,
      resolutionNote: null,
      resolvedAt: null
    }
  ];
  const experiments: ExperimentRecord[] = [
    {
      id: 'exp-1',
      sessionId: 'session-1',
      studyDebtId: 'question-1',
      hypothesis: 'rename avoids torn reads',
      command: 'subagent',
      context: '',
      baseCommitSha: 'abc123',
      branchName: 'h2-exp-1',
      worktreePath: '/tmp/exp-1',
      status: 'running',
      budget: 1000,
      tokensUsed: 0,
      contextTokensUsed: 0,
      toolOutputTokensUsed: 0,
      observationTokensUsed: 0,
      preserve: false,
      createdAt: '2026-04-08T00:00:00.000Z',
      updatedAt: '2026-04-08T00:00:00.000Z',
      resolvedAt: null,
      finalVerdict: null,
      finalSummary: null,
      discovered: [],
      artifacts: [],
      constraints: [],
      confidenceNote: null,
      lowSignalWarningEmitted: false,
      promote: false
    }
  ];

  const score = buildAutoScore(testCase, modelHistory, studyDebts, experiments, false);
  assert.equal(score.duplicateInlineProbingAfterSpawn, 'no');
});
