import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { execa } from 'execa';

import { HeadlessEngine } from '../src/engine/headless-engine.js';
import { DEFAULT_EXPERIMENT_BUDGET_TOKENS, nowIso } from '../src/lib/utils.js';
import { cleanupDir, createGitRepo, waitFor } from '../test-support/helpers.js';

test('HeadlessEngine migrates legacy .harness2 worktrees into .h2/worktrees', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const legacyWorktreeDir = path.join(repoDir, '.harness2', 'worktrees', 'exp-legacy');
  await mkdir(legacyWorktreeDir, { recursive: true });
  await writeFile(path.join(legacyWorktreeDir, 'notes.txt'), 'legacy\n', 'utf8');

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  await assert.doesNotReject(() => access(path.join(repoDir, '.h2', 'worktrees', 'exp-legacy', 'notes.txt')));
  await assert.rejects(() => access(path.join(repoDir, '.harness2', 'worktrees', 'exp-legacy', 'notes.txt')));
});

test('HeadlessEngine routes slash commands through the prototype runner', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir, revealExportsInFinder: false });
  t.after(async () => engine.dispose());
  const originalRunTurn = (engine as any).model.runTurn;
  (engine as any).model.runTurn = async () => {};
  t.after(() => {
    (engine as any).model.runTurn = originalRunTurn;
  });

  await engine.submit('/write notes.txt :: hello from harness2');
  await engine.submit('/read notes.txt');
  await engine.submit(
    '/spawn --hypothesis "inspect the repo in isolation" --local-evidence "The repo has a notes file and the main workspace is writable." --residual-uncertainty "Whether an isolated worktree can inspect the repo safely without touching the main workspace."'
  );

  await waitFor(
    () => engine.snapshot.experiments[0],
    (experiment) => Boolean(experiment)
  );

  const transcript = engine.snapshot.transcript.map((entry) => entry.text).join('\n\n');
  assert.match(transcript, /Wrote 19 chars to notes\.txt\./);
  assert.match(transcript, /notes\.txt/);
  assert.match(transcript, /Spawned exp-/);
  assert.equal(engine.snapshot.experiments.length, 1);
  assert.equal(engine.snapshot.experiments[0]?.budget, DEFAULT_EXPERIMENT_BUDGET_TOKENS);

  const notebook = (engine as any).options.notebook;
  const modelHistory = notebook.listModelHistory(engine.snapshot.session.id);
  assert.ok(
    modelHistory.some(
      (item: any) =>
        item.type === 'message' &&
        item.role === 'assistant' &&
        typeof item.content === 'string' &&
        item.content.includes('Spawned exp-')
    )
  );
});

test('HeadlessEngine read defaults to 100 lines and supports explicit line ranges', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir, revealExportsInFinder: false });
  t.after(async () => engine.dispose());

  const largeFile = Array.from({ length: 150 }, (_, index) => `line ${index + 1}`).join('\n');
  await writeFile(path.join(repoDir, 'slice.txt'), largeFile, 'utf8');

  await engine.submit('/read slice.txt');
  await engine.submit('/read slice.txt 120 125');

  const transcript = engine.snapshot.transcript.map((entry) => entry.text).join('\n\n');
  assert.match(transcript, /slice\.txt \(lines 1-100 of 150\)/);
  assert.match(transcript, /1: line 1/);
  assert.doesNotMatch(transcript, /101: line 101/);
  assert.match(transcript, /slice\.txt \(lines 120-125 of 150\)/);
  assert.match(transcript, /120: line 120/);
  assert.match(transcript, /125: line 125/);
});

test('HeadlessEngine edit applies patch-style file creation and updates', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const createOutput = await (engine as any).runEdit(`*** Begin Patch
*** Add File: src/example.ts
+export const answer = 41;
*** End Patch`);
  assert.match(createOutput, /^@@tool\tedit_diff\tAdd\(src\/example\.ts\)/);
  assert.equal(
    await readFile(path.join(repoDir, 'src', 'example.ts'), 'utf8'),
    'export const answer = 41;'
  );

  const updateOutput = await (engine as any).runEdit(`*** Begin Patch
*** Update File: src/example.ts
@@
-export const answer = 41;
+export const answer = 42;
*** End Patch`);
  assert.match(updateOutput, /^@@tool\tedit_diff\tEdit\(src\/example\.ts\)/);
  assert.equal(
    await readFile(path.join(repoDir, 'src', 'example.ts'), 'utf8'),
    'export const answer = 42;'
  );
});

test('HeadlessEngine bash supports multiline heredocs', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const output = await (engine as any).runBash(`python3 - <<'PY'
print("hello")
for i in range(2):
    print(i)
PY`);

  assert.match(output, /exit: 0/);
  assert.match(output, /hello/);
  assert.match(output, /\n0\n1/);
});

test('HeadlessEngine rg accepts whitespace-separated multi-target strings', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  await writeFile(path.join(repoDir, 'app.txt'), 'alpha\n', 'utf8');
  await mkdir(path.join(repoDir, 'lib'), { recursive: true });
  await writeFile(path.join(repoDir, 'lib', 'notes.txt'), 'alpha\n', 'utf8');

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const output = await (engine as any).runRg('alpha', '. lib');
  assert.match(output, /app\.txt/);
  assert.match(output, /lib\/notes\.txt/);
});

test('HeadlessEngine compact persists harness checkpoint with git state and active experiments', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const notebook = (engine as any).options.notebook;
  const timestamp = nowIso();
  notebook.upsertExperiment({
    id: 'exp-running',
    sessionId: engine.snapshot.session.id,
    studyDebtId: null,
    hypothesis: 'verify checkpoint captures running experiments',
    command: 'subagent',
    context: '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-running',
    worktreePath: path.join(repoDir, '.h2', 'worktrees', 'exp-running'),
    status: 'running',
    budget: 5000,
    tokensUsed: 10,
    contextTokensUsed: 4,
    toolOutputTokensUsed: 3,
    observationTokensUsed: 3,
    preserve: true,
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
  notebook.openStudyDebt({
    sessionId: engine.snapshot.session.id,
    summary: 'runtime continuity is unproven',
    whyItMatters: 'Being wrong would change the next implementation step.',
    kind: 'runtime',
    affectedPaths: ['src/engine']
  });

  const result = await (engine as any).runCompact(
    'verify checkpointing',
    'seeded a running experiment',
    'continue with shorter replay',
    'subagent may still fail'
  );
  assert.equal(result.ok, true);
  assert.equal(typeof result.checkpointId, 'number');

  const checkpoint = notebook.getLatestSessionCheckpoint(engine.snapshot.session.id);
  assert.ok(checkpoint);
  assert.match(checkpoint?.gitLog ?? '', /\b[0-9a-f]{7,}\b/);
  assert.match(checkpoint?.checkpointBlock ?? '', /active_experiments:/);
  assert.match(checkpoint?.checkpointBlock ?? '', /open_questions:/);
  assert.equal(checkpoint?.activeExperimentSummaries[0]?.experimentId, 'exp-running');
});

test('HeadlessEngine submit can stream transcript callbacks for noninteractive callers', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const emitted: Array<{ role: string; text: string }> = [];
  await engine.submit('/read README.md', {
    onTranscriptEntry: async (role, text) => {
      emitted.push({ role, text });
    }
  });

  assert.ok(emitted.some((entry) => entry.role === 'tool' || entry.role === 'assistant'));
  assert.ok(emitted.some((entry) => entry.text.includes('README.md')));
});

test('HeadlessEngine persists a thinking summary once and clears the live overlay when it is appended', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());
  engine.setThinkingEnabled(true);

  const originalRunTurn = (engine as any).model.runTurn;
  (engine as any).model.runTurn = async (
    _sessionId: string,
    _input: string,
    _tools: unknown,
    emit: (role: string, text: string) => Promise<void>,
    _onAssistantStream: (text: string) => Promise<void>,
    onReasoningSummaryStream: (text: string) => Promise<void>
  ) => {
    await onReasoningSummaryStream('Need to inspect the adoption path first.');
    await emit('system', '@@thinking\tNeed to inspect the adoption path first.');
    await emit('tool', '@@tool\tread\tRead(src/engine/headless-engine.ts)\nsrc/engine/headless-engine.ts');
  };
  t.after(() => {
    (engine as any).model.runTurn = originalRunTurn;
  });

  const snapshots: Array<{ role: string; liveThinkingText: string | null }> = [];
  await engine.submit('inspect it', {
    onTranscriptEntry: async (role) => {
      snapshots.push({
        role,
        liveThinkingText:
          [...engine.snapshot.liveTurnEvents]
            .reverse()
            .find((event) => event.kind === 'thinking' && event.live)?.text ?? null
      });
    }
  });

  const thinkingEntries = engine.snapshot.transcript.filter(
    (entry) => entry.role === 'system' && entry.text.startsWith('@@thinking\t')
  );
  assert.equal(thinkingEntries.length, 1);
  assert.equal(engine.snapshot.liveTurnEvents.some((event) => event.kind === 'thinking' && event.live), false);
  assert.equal(
    snapshots.find((entry) => entry.role === 'system')?.liveThinkingText,
    null
  );
});

test('HeadlessEngine preserves completed tool events until the next turn starts', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  let releaseToolFinish: (() => void) | null = null;
  const toolFinished = new Promise<void>((resolve) => {
    releaseToolFinish = resolve;
  });

  const originalRunTurn = (engine as any).model.runTurn;
  (engine as any).model.runTurn = async (
    _sessionId: string,
    _input: string,
    _tools: unknown,
    emit: (role: string, text: string) => Promise<void>,
    _onAssistantStream: ((text: string) => Promise<void>) | undefined,
    _onReasoningSummaryStream: ((text: string) => Promise<void>) | undefined,
    _thinkingEnabled: boolean,
    _toolDefinitions: unknown,
    _instructions: string,
    onToolCallStart: ((toolCall: {
      toolCallId: string;
      toolName: string;
      label: string;
      detail?: string | null;
      body?: string[];
      providerExecuted?: boolean;
    }) => Promise<void>) | undefined,
    onToolCallFinish: ((toolCallId: string, transcriptText?: string) => Promise<void>) | undefined
  ) => {
    await onToolCallStart?.({
      toolCallId: 'call_bash_1',
      toolName: 'bash',
      label: 'Bash(pwd)',
      detail: 'running…',
      body: ['command: pwd'],
      providerExecuted: false
    });
    await toolFinished;
    const transcriptText = '@@tool\tbash\tBash(pwd)\nexit: 0\nstdout:\n/tmp/repo';
    await emit('tool', transcriptText);
    await onToolCallFinish?.('call_bash_1', transcriptText);
  };
  t.after(() => {
    (engine as any).model.runTurn = originalRunTurn;
  });

  const submitPromise = engine.submit('run the check');

  await waitFor(
    () => engine.snapshot.liveTurnEvents.find((event) => event.kind === 'tool' && event.live),
    (toolEvent) => Boolean(toolEvent)
  );

  assert.deepEqual(engine.snapshot.liveTurnEvents.find((event) => event.kind === 'tool' && event.live), {
    id: 'live-tool-1',
    kind: 'tool',
    transcriptText: null,
    live: true,
    callId: 'call_bash_1',
    toolName: 'bash',
    label: 'Bash(pwd)',
    detail: 'running…',
    body: ['command: pwd'],
    providerExecuted: false
  });

  releaseToolFinish?.();
  await submitPromise;
  assert.deepEqual(engine.snapshot.liveTurnEvents, [
    {
      id: 'live-tool-1',
      kind: 'tool',
      transcriptText: '@@tool\tbash\tBash(pwd)\nexit: 0\nstdout:\n/tmp/repo',
      live: false,
      callId: 'call_bash_1',
      toolName: null,
      label: null,
      detail: null,
      body: [],
      providerExecuted: false
    }
  ]);

  await engine.submit('/read README.md');
  assert.equal(
    engine.snapshot.liveTurnEvents.some(
      (event) => event.kind === 'tool' && event.callId === 'call_bash_1'
    ),
    false
  );
});

test('HeadlessEngine can preview and apply a preserved experiment back into the main workspace', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const baseCommitSha = (
    await execa('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir
    })
  ).stdout.trim();
  const worktreePath = path.join(repoDir, '.h2', 'worktrees', 'exp-adopt');
  await execa('git', ['worktree', 'add', '-b', 'h2-exp-adopt', worktreePath, 'HEAD'], {
    cwd: repoDir
  });

  await writeFile(path.join(worktreePath, 'feature.txt'), 'hello from experiment\n', 'utf8');
  await writeFile(path.join(worktreePath, 'README.md'), '# temp repo\nupdated by experiment\n', 'utf8');

  const notebook = (engine as any).options.notebook;
  const timestamp = nowIso();
  notebook.upsertExperiment({
    id: 'exp-adopt',
    sessionId: engine.snapshot.session.id,
    studyDebtId: null,
    hypothesis: 'preserved changes should be adoptable',
    command: 'subagent',
    context: '',
    baseCommitSha,
    branchName: 'h2-exp-adopt',
    worktreePath,
    status: 'validated',
    budget: 50000,
    tokensUsed: 100,
    contextTokensUsed: 10,
    toolOutputTokensUsed: 70,
    observationTokensUsed: 20,
    preserve: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: timestamp,
    finalVerdict: 'validated',
    finalSummary: 'experiment produced reusable changes',
    discovered: ['tracked and untracked changes available'],
    artifacts: ['feature.txt'],
    constraints: [],
    confidenceNote: 'high confidence for local adoption',
    lowSignalWarningEmitted: false,
    promote: true
  });

  await engine.submit('/adopt exp-adopt');
  let transcript = engine.snapshot.transcript.map((entry) => entry.text).join('\n\n');
  assert.match(transcript, /Experiment adoption preview/);
  assert.match(transcript, /feature\.txt/);
  assert.match(transcript, /Run \/adopt exp-adopt --apply/);

  const rootReadmeBefore = await readFile(path.join(repoDir, 'README.md'), 'utf8');
  assert.equal(rootReadmeBefore, '# temp repo\n');

  await engine.submit('/adopt exp-adopt --apply');
  transcript = engine.snapshot.transcript.map((entry) => entry.text).join('\n\n');
  assert.match(transcript, /Experiment adoption applied/);
  assert.match(transcript, /rollback: h2-adopt-backup-/);

  const rootReadmeAfter = await readFile(path.join(repoDir, 'README.md'), 'utf8');
  const adoptedFile = await readFile(path.join(repoDir, 'feature.txt'), 'utf8');
  assert.match(rootReadmeAfter, /updated by experiment/);
  assert.equal(adoptedFile, 'hello from experiment\n');
});

test('HeadlessEngine blocks main-workspace edits while a matching open question is open', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const notebook = (engine as any).options.notebook;
  const debt = notebook.openStudyDebt({
    sessionId: engine.snapshot.session.id,
    summary: 'guest-to-login continuity is unproven',
    whyItMatters: 'Being wrong would materially change auth transfer behavior.',
    kind: 'runtime',
    affectedPaths: ['README.md'],
    recommendedStudy: 'run the guest-sign-in continuity flow first'
  });

  await assert.rejects(
    () => (engine as any).runWrite('README.md', '# blocked\n'),
    /An open question blocks this edit/
  );

  await (engine as any).resolveStudyDebt({
    questionId: debt.id,
    resolution: 'static_evidence_sufficient',
    note: 'README edit is now justified by direct code evidence.'
  });

  await assert.doesNotReject(() => (engine as any).runWrite('README.md', '# allowed\n'));
});

test('HeadlessEngine open-question path scoping blocks matching paths but allows unrelated edits', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const notebook = (engine as any).options.notebook;
  notebook.openStudyDebt({
    sessionId: engine.snapshot.session.id,
    summary: 'auth continuity is unproven',
    whyItMatters: 'Wrong assumptions would change auth-path implementation.',
    kind: 'runtime',
    affectedPaths: ['src/auth']
  });

  await assert.doesNotReject(() => (engine as any).runWrite('notes.txt', 'safe\n'));
  await assert.rejects(
    () => (engine as any).runWrite('src/auth/flow.ts', 'blocked\n'),
    /An open question blocks this edit/
  );
});

test('HeadlessEngine latches repeated open-question mutation blocks within the same turn', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const notebook = (engine as any).options.notebook;
  notebook.openStudyDebt({
    sessionId: engine.snapshot.session.id,
    summary: 'auth continuity is unproven',
    whyItMatters: 'Being wrong would materially change the dependent edit.',
    kind: 'runtime',
    affectedPaths: ['README.md'],
    recommendedStudy: 'run the guest-login continuity flow first'
  });

  await assert.rejects(
    () => (engine as any).runWrite('README.md', '# blocked once\n'),
    /recommended_study=run the guest-login continuity flow first/
  );

  await assert.rejects(
    () => (engine as any).runWrite('README.md', '# blocked twice\n'),
    /An open question still blocks this edit\.\nquestions: question-/
  );
});

test('HeadlessEngine blocks all main-workspace edits when an open question has no affected paths', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const notebook = (engine as any).options.notebook;
  notebook.openStudyDebt({
    sessionId: engine.snapshot.session.id,
    summary: 'chosen approach is still unproven',
    whyItMatters: 'Being wrong would materially change the implementation path.',
    kind: 'architecture'
  });

  await assert.rejects(
    () => (engine as any).runWrite('notes.txt', 'blocked\n'),
    /An open question blocks this edit/
  );
});

test('HeadlessEngine does not apply main-session open questions to experiment worktree edits', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const notebook = (engine as any).options.notebook;
  notebook.openStudyDebt({
    sessionId: engine.snapshot.session.id,
    summary: 'chosen approach is still unproven',
    whyItMatters: 'Main-workspace edits should stay blocked until the debt is discharged.',
    kind: 'architecture'
  });

  const worktreeDir = path.join(repoDir, '.h2', 'worktrees', 'exp-test');
  await assert.doesNotReject(() =>
    (engine as any).runWriteAtRoot(worktreeDir, 'notes.txt', 'experiment-safe\n')
  );
  assert.equal(await readFile(path.join(worktreeDir, 'notes.txt'), 'utf8'), 'experiment-safe\n');
});

test('HeadlessEngine defaults experiment subagents to gpt-5.4-mini with high reasoning', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const originalRunTurn = (engine as any).model.runTurn;
  let recordedModel: string | null = null;
  (engine as any).model.runTurn = async (
    sessionId: string,
    _input: string,
    _tools: unknown,
    _emit: unknown,
    _onAssistantStream: unknown,
    _onReasoningSummaryStream: unknown,
    _thinkingEnabled: boolean,
    _toolDefinitions: unknown,
    _instructions: string
  ) => {
    recordedModel = (engine as any).model.getSettings(sessionId).model;
  };
  t.after(() => {
    (engine as any).model.runTurn = originalRunTurn;
  });

  const timestamp = nowIso();
  const experimentSessionId = (engine as any).experimentManager.getExperimentSessionId(
    'exp-model-default'
  );
  (engine as any).options.notebook.createSession(
    experimentSessionId,
    path.join(repoDir, '.h2', 'worktrees', 'exp-model-default')
  );
  await (engine as any).runExperimentSubagent({
    id: 'exp-model-default',
    sessionId: engine.snapshot.session.id,
    studyDebtId: null,
    hypothesis: 'inspect the repo in isolation',
    command: 'subagent',
    context: '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-model-default',
    worktreePath: path.join(repoDir, '.h2', 'worktrees', 'exp-model-default'),
    status: 'running',
    budget: 1000,
    tokensUsed: 0,
    contextTokensUsed: 0,
    toolOutputTokensUsed: 0,
    observationTokensUsed: 0,
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

  assert.equal(recordedModel, 'gpt-5.4-mini');
  assert.equal((engine as any).model.getSettings(experimentSessionId).reasoningEffort, 'high');
});

test('HeadlessEngine requires questionId when spawning an experiment with an open question', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const notebook = (engine as any).options.notebook;
  const experimentManager = (engine as any).experimentManager;
  const originalSpawn = experimentManager.spawn.bind(experimentManager);
  experimentManager.spawn = async (input: any) => ({
    id: 'exp-stubbed',
    sessionId: input.sessionId,
    studyDebtId: input.studyDebtId ?? null,
    hypothesis: input.hypothesis,
    command: 'subagent',
    context: input.context ?? '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-stubbed',
    worktreePath: path.join(repoDir, '.h2', 'worktrees', 'exp-stubbed'),
    status: 'running',
    budget: input.budgetTokens,
    tokensUsed: 0,
    contextTokensUsed: 0,
    toolOutputTokensUsed: 0,
    observationTokensUsed: 0,
    preserve: input.preserve,
    createdAt: nowIso(),
    updatedAt: nowIso(),
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
  t.after(() => {
    experimentManager.spawn = originalSpawn;
  });
  const debt = notebook.openStudyDebt({
    sessionId: engine.snapshot.session.id,
    summary: 'runtime continuity is unproven',
    whyItMatters: 'Being wrong would materially change the implementation choice.',
    kind: 'runtime'
  });

  await assert.rejects(
    () =>
      (engine as any).spawnExperiment({
        hypothesis: 'probe continuity handling',
        localEvidenceSummary: 'The repo suggests continuity may cross auth boundaries.',
        residualUncertainty: 'Whether the current flow preserves the same chat after sign-in.',
        budgetTokens: 1200,
        preserve: false
      }),
    /must be tied to a question/
  );

  await assert.doesNotReject(() =>
    (engine as any).spawnExperiment({
      questionId: debt.id,
      hypothesis: 'probe continuity handling',
      localEvidenceSummary: 'The repo suggests continuity may cross auth boundaries.',
      residualUncertainty: 'Whether the current flow preserves the same chat after sign-in.',
      budgetTokens: 1200,
      preserve: false
    })
  );
});

test('HeadlessEngine rejects spawn_experiment pinned to an unknown or closed question', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const notebook = (engine as any).options.notebook;
  const debt = notebook.openStudyDebt({
    sessionId: engine.snapshot.session.id,
    summary: 'runtime continuity is unproven',
    whyItMatters: 'Being wrong would materially change the implementation choice.',
    kind: 'runtime'
  });

  await assert.rejects(
    () =>
      (engine as any).spawnExperiment({
        questionId: 'question-missing',
        hypothesis: 'probe continuity handling',
        localEvidenceSummary: 'The repo suggests continuity may cross auth boundaries.',
        residualUncertainty: 'Whether the current flow preserves the same chat after sign-in.',
        budgetTokens: 1200,
        preserve: false
      }),
    /Unknown question/
  );

  await (engine as any).resolveStudyDebt({
    questionId: debt.id,
    resolution: 'static_evidence_sufficient',
    note: 'Resolved directly from repo evidence.'
  });

  await assert.rejects(
    () =>
      (engine as any).spawnExperiment({
        questionId: debt.id,
        hypothesis: 'probe continuity handling',
        localEvidenceSummary: 'The repo suggests continuity may cross auth boundaries.',
        residualUncertainty: 'Whether the current flow preserves the same chat after sign-in.',
        budgetTokens: 1200,
        preserve: false
      }),
    /already closed/
  );
});

test('HeadlessEngine rejects spawning a second active experiment on the same question', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const notebook = (engine as any).options.notebook;
  const experimentManager = (engine as any).experimentManager;
  const originalSpawn = experimentManager.spawn.bind(experimentManager);
  experimentManager.spawn = async (input: any) => ({
    id: 'exp-stubbed-next',
    sessionId: input.sessionId,
    studyDebtId: input.studyDebtId ?? null,
    hypothesis: input.hypothesis,
    command: 'subagent',
    context: input.context ?? '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-stubbed-next',
    worktreePath: path.join(repoDir, '.h2', 'worktrees', 'exp-stubbed-next'),
    status: 'running',
    budget: input.budgetTokens,
    tokensUsed: 0,
    contextTokensUsed: 0,
    toolOutputTokensUsed: 0,
    observationTokensUsed: 0,
    preserve: input.preserve,
    createdAt: nowIso(),
    updatedAt: nowIso(),
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
  t.after(() => {
    experimentManager.spawn = originalSpawn;
  });
  const debt = notebook.openStudyDebt({
    sessionId: engine.snapshot.session.id,
    summary: 'queue ownership is still under study',
    whyItMatters: 'Being wrong would materially change the execution model.',
    kind: 'runtime'
  });

  const timestamp = nowIso();
  notebook.upsertExperiment({
    id: 'exp-running-linked',
    sessionId: engine.snapshot.session.id,
    studyDebtId: debt.id,
    hypothesis: 'one worker can claim jobs without duplicate processing',
    command: 'subagent',
    context: '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-running-linked',
    worktreePath: path.join(repoDir, '.h2', 'worktrees', 'exp-running-linked'),
    status: 'running',
    budget: 1200,
    tokensUsed: 0,
    contextTokensUsed: 0,
    toolOutputTokensUsed: 0,
    observationTokensUsed: 0,
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

  await assert.rejects(
    () =>
      (engine as any).spawnExperiment({
        questionId: debt.id,
        hypothesis: 'sqlite locking will tolerate two workers',
        localEvidenceSummary: 'One experiment is already running against this same ownership claim.',
        residualUncertainty: 'Whether another variant should run in parallel.',
        budgetTokens: 1200,
        preserve: false
    }),
    /already has an active linked experiment/
  );

  notebook.upsertExperiment({
    ...(notebook.getExperiment('exp-running-linked') as any),
    status: 'inconclusive',
    finalVerdict: 'inconclusive',
    finalSummary: 'Closed the first study so a new linked experiment can start later.',
    resolvedAt: nowIso(),
    updatedAt: nowIso()
  });

  await assert.doesNotReject(() =>
    (engine as any).spawnExperiment({
      questionId: debt.id,
      hypothesis: 'sqlite locking will tolerate two workers',
      localEvidenceSummary: 'The earlier study resolved and no linked experiment is still active.',
      residualUncertainty: 'Whether the alternative claim/update sequence is safer.',
      budgetTokens: 1200,
      preserve: false
    })
  );
});

test('HeadlessEngine searchExperiments returns a guardrail when no current question is open', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const result = await (engine as any).searchExperiments('oauth');
  assert.deepEqual(result, {
    ok: false,
    guardrail:
      'search_experiments is subordinate to the current task. Open the live question first, or explicitly say why no question is needed before searching prior experiments.',
    suggestedNext: [
      'Name the implementation-changing uncertainty.',
      'Open the question if dependent edits rely on it.',
      'Then search for prior findings only if they may answer or narrow that same question.'
    ]
  });
});

test('HeadlessEngine rejects resolving an open question as static evidence after a linked invalidation', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const notebook = (engine as any).options.notebook;
  const question = notebook.openStudyDebt({
    sessionId: engine.snapshot.session.id,
    summary: 'fallback retry semantics are unproven',
    whyItMatters: 'Being wrong would materially change the implementation path.',
    kind: 'runtime',
    affectedPaths: ['README.md']
  });
  const timestamp = nowIso();
  notebook.upsertExperiment({
    id: 'exp-invalidated',
    sessionId: engine.snapshot.session.id,
    studyDebtId: question.id,
    hypothesis: 'the failed partial can stay in canonical state during retry',
    command: 'subagent',
    context: '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-invalidated',
    worktreePath: path.join(repoDir, '.h2', 'worktrees', 'exp-invalidated'),
    status: 'invalidated',
    budget: 5000,
    tokensUsed: 250,
    contextTokensUsed: 10,
    toolOutputTokensUsed: 220,
    observationTokensUsed: 20,
    preserve: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: timestamp,
    finalVerdict: 'invalidated',
    finalSummary: 'Retaining the partial assistant corrupts the retry path.',
    discovered: [],
    artifacts: [],
    constraints: [],
    confidenceNote: null,
    lowSignalWarningEmitted: false,
    promote: false
  });

  await assert.rejects(
    () =>
      (engine as any).resolveStudyDebt({
        questionId: question.id,
        resolution: 'static_evidence_sufficient',
        note: 'I think static repo evidence is enough now.'
      }),
    /linked to invalidated experiment/
  );

  await assert.doesNotReject(() =>
    (engine as any).resolveStudyDebt({
      questionId: question.id,
      resolution: 'scope_narrowed',
      note: 'Narrow to a path that removes the failed partial before retry.'
    })
  );
});

test('HeadlessEngine rejects resolving a question while a linked experiment is still active', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const notebook = (engine as any).options.notebook;
  const question = notebook.openStudyDebt({
    sessionId: engine.snapshot.session.id,
    summary: 'provider contract is still under study',
    whyItMatters: 'Being wrong would materially change the implementation path.',
    kind: 'runtime'
  });

  const timestamp = nowIso();
  notebook.upsertExperiment({
    id: 'exp-running-question',
    sessionId: engine.snapshot.session.id,
    studyDebtId: question.id,
    hypothesis: 'responses API emits the needed stream shape',
    command: 'subagent',
    context: '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-running-question',
    worktreePath: path.join(repoDir, '.h2', 'worktrees', 'exp-running-question'),
    status: 'running',
    budget: 1200,
    tokensUsed: 0,
    contextTokensUsed: 0,
    toolOutputTokensUsed: 0,
    observationTokensUsed: 0,
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

  await assert.rejects(
    () =>
      (engine as any).resolveStudyDebt({
        questionId: question.id,
        resolution: 'study_run',
        note: 'Resolved before the study finished.'
      }),
    /active linked experiment/
  );
});

test('HeadlessEngine blocks overlapping inline read probes while a linked experiment is active', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  await mkdir(path.join(repoDir, 'src', 'auth'), { recursive: true });
  await writeFile(path.join(repoDir, 'src', 'auth', 'flow.ts'), 'export const flow = true;\n', 'utf8');
  await writeFile(path.join(repoDir, 'notes.txt'), 'safe\n', 'utf8');

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const notebook = (engine as any).options.notebook;
  const question = notebook.openStudyDebt({
    sessionId: engine.snapshot.session.id,
    summary: 'auth continuity is under experiment',
    whyItMatters: 'Being wrong would materially change the auth flow.',
    kind: 'runtime',
    affectedPaths: ['src/auth']
  });

  const timestamp = nowIso();
  notebook.upsertExperiment({
    id: 'exp-auth-running',
    sessionId: engine.snapshot.session.id,
    studyDebtId: question.id,
    hypothesis: 'guest continuity survives auth transitions',
    command: 'subagent',
    context: '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-auth-running',
    worktreePath: path.join(repoDir, '.h2', 'worktrees', 'exp-auth-running'),
    status: 'running',
    budget: 5000,
    tokensUsed: 100,
    contextTokensUsed: 10,
    toolOutputTokensUsed: 80,
    observationTokensUsed: 10,
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

  await assert.rejects(
    () => (engine as any).runRead('src/auth/flow.ts'),
    /Use wait_experiment or read_experiment before more inline probing on the same question/i
  );

  await assert.doesNotReject(() => (engine as any).runRead('notes.txt'));
});

test('HeadlessEngine surfaces linked invalidations in open-question mutation blocks', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir });
  t.after(async () => engine.dispose());

  const notebook = (engine as any).options.notebook;
  const question = notebook.openStudyDebt({
    sessionId: engine.snapshot.session.id,
    summary: 'fallback retry semantics are unproven',
    whyItMatters: 'Being wrong would materially change the implementation path.',
    kind: 'runtime',
    affectedPaths: ['README.md']
  });
  const timestamp = nowIso();
  notebook.upsertExperiment({
    id: 'exp-invalidated',
    sessionId: engine.snapshot.session.id,
    studyDebtId: question.id,
    hypothesis: 'the failed partial can stay in canonical state during retry',
    command: 'subagent',
    context: '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-invalidated',
    worktreePath: path.join(repoDir, '.h2', 'worktrees', 'exp-invalidated'),
    status: 'invalidated',
    budget: 5000,
    tokensUsed: 250,
    contextTokensUsed: 10,
    toolOutputTokensUsed: 220,
    observationTokensUsed: 20,
    preserve: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: timestamp,
    finalVerdict: 'invalidated',
    finalSummary: 'Retaining the partial assistant corrupts the retry path.',
    discovered: [],
    artifacts: [],
    constraints: [],
    confidenceNote: null,
    lowSignalWarningEmitted: false,
    promote: false
  });

  await assert.rejects(
    () => (engine as any).runWrite('README.md', '# blocked\n'),
    /linked_invalidated_experiments=exp-invalidated:Retaining the partial assistant corrupts the retry path\./
  );
});

test('HeadlessEngine exports the current session to markdown via /export', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const engine = await HeadlessEngine.open({ cwd: repoDir, revealExportsInFinder: false });
  t.after(async () => engine.dispose());

  await engine.submit('/read README.md');
  await engine.submit('/export');

  const exportPath = path.join(repoDir, '.h2', 'session-exports', `${engine.snapshot.session.id}.md`);
  await assert.doesNotReject(() => access(exportPath));

  const exported = await readFile(exportPath, 'utf8');
  assert.match(exported, new RegExp(`# Session Export ${engine.snapshot.session.id}`));
  assert.match(exported, /## Transcript/);
  assert.match(exported, /README\.md/);

  const transcript = engine.snapshot.transcript.map((entry) => entry.text).join('\n\n');
  assert.match(transcript, /Exported .*session-exports/);
});
