import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { Notebook } from '../src/storage/notebook.js';
import type { ExperimentRecord } from '../src/types.js';
import { nowIso } from '../src/lib/utils.js';
import { cleanupDir, createTempDir } from '../test-support/helpers.js';

test('Notebook persists transcript and experiment details', async (t) => {
  const tempDir = await createTempDir('h2-notebook-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());

  const session = notebook.createSession('session-test', tempDir);
  notebook.appendTranscript(session.id, 'user', 'hello');
  notebook.appendTranscript(session.id, 'assistant', 'world');
  notebook.appendModelHistoryItem(session.id, {
    type: 'message',
    role: 'user',
    content: 'hello'
  });
  notebook.appendModelHistoryItem(session.id, {
    type: 'function_call',
    call_id: 'call_1',
    name: 'read',
    arguments: '{"path":"README.md"}'
  });
  notebook.appendModelHistoryItem(session.id, {
    type: 'function_call_output',
    call_id: 'call_1',
    output: 'README content'
  });

  const timestamp = nowIso();
  const experiment: ExperimentRecord = {
    id: 'exp-test',
    sessionId: session.id,
    studyDebtId: null,
    hypothesis: 'writing observations is durable',
    command: 'subagent',
    context: 'test context',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-test',
    worktreePath: path.join(tempDir, 'worktree'),
    status: 'validated',
    budget: 1200,
    tokensUsed: 42,
    contextTokensUsed: 10,
    toolOutputTokensUsed: 20,
    observationTokensUsed: 12,
    preserve: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: timestamp,
    finalVerdict: 'validated',
    finalSummary: 'looks good',
    discovered: ['readme note'],
    artifacts: ['notes.txt'],
    constraints: ['local-only'],
    confidenceNote: 'Validated by durable record.',
    lowSignalWarningEmitted: false,
    promote: true
  };

  notebook.upsertExperiment(experiment);
  notebook.appendObservation(experiment.id, 'first observation', ['discovery']);

  const snapshot = notebook.getSnapshot(session.id, false, null, 'idle');
  assert.equal(snapshot.transcript.length, 2);
  assert.equal(snapshot.experiments.length, 1);
  assert.deepEqual(snapshot.liveTurnEvents, []);
  assert.equal(snapshot.currentTurnStartedAt, null);
  assert.equal(snapshot.experiments[0]?.id, experiment.id);
  assert.equal(notebook.listModelHistory(session.id).length, 3);
  assert.deepEqual(notebook.listModelHistory(session.id)[1], {
    type: 'function_call',
    call_id: 'call_1',
    name: 'read',
    arguments: '{"path":"README.md"}'
  });

  const details = notebook.getExperimentDetails(experiment.id);
  assert.ok(details);
  assert.equal(details?.observations.length, 1);
  assert.equal(details?.observations[0]?.message, 'first observation');
  assert.deepEqual(details?.observations[0]?.tags, ['discovery']);
  assert.deepEqual(details?.discovered, ['readme note']);
  assert.equal(details?.promote, true);

  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: 'access',
    refreshToken: 'refresh',
    idToken: 'id',
    accountId: 'acct',
    expiresAt: 123,
    createdAt: timestamp,
    updatedAt: timestamp
  });

  assert.equal(notebook.getOpenAICodexAuth()?.accountId, 'acct');
  assert.equal(notebook.deleteOpenAICodexAuth(), true);
  assert.equal(notebook.getOpenAICodexAuth(), null);

  notebook.upsertModelSession({
    sessionId: session.id,
    provider: 'openai-codex',
    model: 'gpt-5-codex',
    reasoningEffort: 'medium',
    previousResponseId: 'resp_123',
    updatedAt: timestamp
  });

  assert.equal(notebook.getModelSession(session.id)?.previousResponseId, 'resp_123');
  assert.equal(notebook.getModelSession(session.id)?.reasoningEffort, 'medium');
  assert.equal(notebook.searchExperimentDetails(session.id, 'observation').length, 1);
  assert.deepEqual(notebook.searchExperimentSummaries(session.id, 'readme'), [
    {
      experimentId: 'exp-test',
      hypothesis: 'writing observations is durable',
      status: 'validated',
      summary: 'looks good',
      discovered: ['readme note']
    }
  ]);
});

test('Notebook searchExperimentSummaries finds durable experiment summaries without logs', async (t) => {
  const tempDir = await createTempDir('h2-notebook-search-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());

  const session = notebook.createSession('session-search', tempDir);
  const timestamp = nowIso();

  notebook.upsertExperiment({
    id: 'exp-alpha',
    sessionId: session.id,
    studyDebtId: null,
    hypothesis: 'check oauth callback behavior',
    command: 'subagent',
    context: '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-alpha',
    worktreePath: path.join(tempDir, 'alpha'),
    status: 'validated',
    budget: 100,
    tokensUsed: 25,
    contextTokensUsed: 5,
    toolOutputTokensUsed: 10,
    observationTokensUsed: 10,
    preserve: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: timestamp,
    finalVerdict: 'validated',
    finalSummary: 'OAuth callback reached localhost',
    discovered: ['callback server binds on localhost'],
    artifacts: ['localhost callback'],
    constraints: ['browser required'],
    confidenceNote: 'Observed directly in test flow.',
    lowSignalWarningEmitted: false,
    promote: false
  });
  notebook.appendObservation('exp-alpha', 'Observed callback roundtrip in browser flow.', ['discovery']);

  notebook.upsertExperiment({
    id: 'exp-beta',
    sessionId: session.id,
    studyDebtId: null,
    hypothesis: 'measure token budgeting',
    command: 'subagent',
    context: '',
    baseCommitSha: 'def456',
    branchName: 'h2-exp-beta',
    worktreePath: path.join(tempDir, 'beta'),
    status: 'inconclusive',
    budget: 100,
    tokensUsed: 110,
    contextTokensUsed: 20,
    toolOutputTokensUsed: 60,
    observationTokensUsed: 30,
    preserve: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: timestamp,
    finalVerdict: 'inconclusive',
    finalSummary: 'Budget exhausted early',
    discovered: ['token estimator overshoots on large diffs'],
    artifacts: [],
    constraints: ['budget too small'],
    confidenceNote: 'Result is partial.',
    lowSignalWarningEmitted: true,
    promote: false
  });
  notebook.appendObservation('exp-beta', 'Blocked on large diff output.', ['blocker']);

  assert.deepEqual(
    notebook.searchExperimentSummaries(session.id, 'oauth'),
    [
      {
        experimentId: 'exp-alpha',
        hypothesis: 'check oauth callback behavior',
        status: 'validated',
        summary: 'OAuth callback reached localhost',
        discovered: ['callback server binds on localhost']
      }
    ]
  );
  assert.deepEqual(
    notebook.searchExperimentSummaries(session.id, 'large diff'),
    [
      {
        experimentId: 'exp-beta',
        hypothesis: 'measure token budgeting',
        status: 'inconclusive',
        summary: 'Budget exhausted early',
        discovered: ['token estimator overshoots on large diffs']
      }
    ]
  );
  assert.equal(
    JSON.stringify(notebook.searchExperimentSummaries(session.id, 'large diff')).includes('Blocked on large diff output.'),
    false
  );
  assert.deepEqual(notebook.searchExperimentSummaries(session.id, 'does-not-exist'), []);
});

test('Notebook clearExperimentJournal removes persisted experiment history and blocks active experiments by default', async (t) => {
  const tempDir = await createTempDir('h2-notebook-clear-journal-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());

  const session = notebook.createSession('session-clear', tempDir);
  const timestamp = nowIso();

  notebook.upsertExperiment({
    id: 'exp-running',
    sessionId: session.id,
    studyDebtId: null,
    hypothesis: 'still running',
    command: 'subagent',
    context: '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-running',
    worktreePath: path.join(tempDir, 'running'),
    status: 'running',
    budget: 100,
    tokensUsed: 10,
    contextTokensUsed: 2,
    toolOutputTokensUsed: 4,
    observationTokensUsed: 4,
    preserve: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: null,
    finalVerdict: null,
    finalSummary: null,
    discovered: [],
    artifacts: [],
    constraints: [],
    confidenceNote: null,
    lowSignalWarningEmitted: false,
    promote: false
  });
  notebook.appendObservation('exp-running', 'still active', ['question']);

  const blocked = notebook.clearExperimentJournal(session.id);
  assert.deepEqual(blocked, {
    clearedExperiments: 0,
    clearedObservations: 0,
    blockedActive: 1
  });
  assert.equal(notebook.listExperiments(session.id).length, 1);

  const forced = notebook.clearExperimentJournal(session.id, { force: true });
  assert.deepEqual(forced, {
    clearedExperiments: 1,
    clearedObservations: 1,
    blockedActive: 0
  });
  assert.equal(notebook.listExperiments(session.id).length, 0);
});

test('Notebook persists checkpoints and rebuilds compacted request history from latest checkpoint', async (t) => {
  const tempDir = await createTempDir('h2-notebook-compact-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());

  const session = notebook.createSession('session-compact', tempDir);
  notebook.appendModelHistoryItem(session.id, {
    type: 'message',
    role: 'user',
    content: 'first'
  });
  notebook.appendModelHistoryItem(session.id, {
    type: 'message',
    role: 'assistant',
    content: 'second'
  });
  notebook.appendModelHistoryItem(session.id, {
    type: 'message',
    role: 'user',
    content: 'tail-one'
  });
  notebook.appendModelHistoryItem(session.id, {
    type: 'message',
    role: 'assistant',
    content: 'tail-two'
  });

  const firstCheckpoint = notebook.createSessionCheckpoint({
    sessionId: session.id,
    goal: 'ship compaction',
    completed: 'persist checkpoint',
    next: 'rebuild next request',
    openRisks: 'tail length too short',
    gitLog: 'abc123 first commit',
    gitStatus: ' M src/storage/notebook.ts',
    gitDiffStat: ' src/storage/notebook.ts | 10 +++++-----',
    lastTestStatus: 'npm test | exit 0 | ok',
    activeExperimentSummaries: [
      {
        experimentId: 'exp-running',
        hypothesis: 'verify compaction replay',
        status: 'running',
        summary: '',
        discovered: []
      }
    ],
    checkpointBlock: 'Harness checkpoint v1',
    tailStartHistoryId: 3
  });

  assert.equal(firstCheckpoint.goal, 'ship compaction');
  assert.match(firstCheckpoint.gitLog, /abc123/);
  assert.equal(firstCheckpoint.activeExperimentSummaries.length, 1);

  assert.deepEqual(notebook.buildModelRequestHistory(session.id), [
    {
      type: 'message',
      role: 'developer',
      content: 'Harness checkpoint v1'
    },
    {
      type: 'message',
      role: 'user',
      content: 'tail-one'
    },
    {
      type: 'message',
      role: 'assistant',
      content: 'tail-two'
    }
  ]);

  const secondCheckpoint = notebook.createSessionCheckpoint({
    sessionId: session.id,
    goal: 'ship compaction',
    completed: 'persist newer checkpoint',
    next: 'trim replay further',
    gitLog: 'def456 second commit',
    gitStatus: '(clean)',
    gitDiffStat: '(clean)',
    activeExperimentSummaries: [],
    checkpointBlock: 'Harness checkpoint v2',
    tailStartHistoryId: 4
  });

  assert.ok(secondCheckpoint.id > firstCheckpoint.id);
  assert.equal(notebook.getLatestSessionCheckpoint(session.id)?.checkpointBlock, 'Harness checkpoint v2');
  assert.deepEqual(notebook.buildModelRequestHistory(session.id), [
    {
      type: 'message',
      role: 'developer',
      content: 'Harness checkpoint v2'
    },
    {
      type: 'message',
      role: 'assistant',
      content: 'tail-two'
    }
  ]);
});

test('Notebook persists open questions without injecting reminder developer messages into request history', async (t) => {
  const tempDir = await createTempDir('h2-notebook-open-question-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());

  const session = notebook.createSession('session-open-question', tempDir);
  notebook.appendModelHistoryItem(session.id, {
    type: 'message',
    role: 'user',
    content: 'investigate auth continuity'
  });

  const debt = notebook.openStudyDebt({
    sessionId: session.id,
    summary: 'guest-to-login chat continuity is unproven',
    whyItMatters: 'Being wrong would change the auth transfer implementation.',
    kind: 'runtime',
    affectedPaths: ['app/(auth)', 'lib/db/queries.ts'],
    recommendedStudy: 'guest creates chat, signs in, returns to same chat'
  });

  assert.equal(debt.status, 'open');
  assert.equal(notebook.listOpenStudyDebts(session.id).length, 1);

  const requestHistory = notebook.buildModelRequestHistory(session.id);
  const firstHistoryItem = requestHistory[0];
  assert.equal(firstHistoryItem?.type, 'message');
  assert.equal(firstHistoryItem?.role, 'user');
  assert.equal(typeof firstHistoryItem?.content, 'string');
  assert.match(firstHistoryItem.content, /investigate auth continuity/);

  const timestamp = nowIso();
  notebook.upsertExperiment({
    id: 'exp-invalidated',
    sessionId: session.id,
    studyDebtId: debt.id,
    hypothesis: 'the current path is safe',
    command: 'subagent',
    context: '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-invalidated',
    worktreePath: path.join(tempDir, 'worktree'),
    status: 'invalidated',
    budget: 5000,
    tokensUsed: 200,
    contextTokensUsed: 20,
    toolOutputTokensUsed: 160,
    observationTokensUsed: 20,
    preserve: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: timestamp,
    finalVerdict: 'invalidated',
    finalSummary: 'The original path is unsafe.',
    discovered: [],
    artifacts: [],
    constraints: [],
    confidenceNote: null,
    lowSignalWarningEmitted: false,
    promote: false
  });

  notebook.createSessionCheckpoint({
    sessionId: session.id,
    goal: 'preserve continuity',
    completed: 'identified guest/login ambiguity',
    next: 'run bounded study',
    gitLog: 'abc123 checkpoint',
    gitStatus: '(clean)',
    gitDiffStat: '(clean)',
    activeExperimentSummaries: [],
    checkpointBlock: 'Harness checkpoint with debt',
    tailStartHistoryId: 1
  });

  const compactedHistory = notebook.buildModelRequestHistory(session.id);
  assert.deepEqual(compactedHistory.slice(0, 1), [
    {
      type: 'message',
      role: 'developer',
      content: 'Harness checkpoint with debt'
    }
  ]);

  const resolved = notebook.resolveStudyDebt({
    questionId: debt.id,
    resolution: 'scope_narrowed',
    note: 'Limited the feature to preserve continuity only on the same chat route.'
  });
  assert.equal(resolved.status, 'closed');
  assert.equal(notebook.listOpenStudyDebts(session.id).length, 0);
});

test('Notebook rejects resolving a question while a linked experiment is still active', async (t) => {
  const tempDir = await createTempDir('h2-notebook-active-experiment-question-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());

  const session = notebook.createSession('session-active-question', tempDir);
  const debt = notebook.openStudyDebt({
    sessionId: session.id,
    summary: 'recovery semantics are still under study',
    whyItMatters: 'Being wrong would materially change the durable behavior.',
    kind: 'runtime'
  });

  const timestamp = nowIso();
  notebook.upsertExperiment({
    id: 'exp-running-linked',
    sessionId: session.id,
    studyDebtId: debt.id,
    hypothesis: 'completed work can survive restart without duplication',
    command: 'subagent',
    context: '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-running-linked',
    worktreePath: path.join(tempDir, 'running'),
    status: 'running',
    budget: 100,
    tokensUsed: 10,
    contextTokensUsed: 2,
    toolOutputTokensUsed: 4,
    observationTokensUsed: 4,
    preserve: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: null,
    finalVerdict: null,
    finalSummary: null,
    discovered: [],
    artifacts: [],
    constraints: [],
    confidenceNote: null,
    lowSignalWarningEmitted: false,
    promote: false
  });

  assert.throws(
    () =>
      notebook.resolveStudyDebt({
        questionId: debt.id,
        resolution: 'study_run',
        note: 'Looks answered.'
      }),
    /active linked experiment/
  );
});
