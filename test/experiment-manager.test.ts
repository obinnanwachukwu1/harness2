import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { execa } from 'execa';

import { ExperimentManager } from '../src/experiments/experiment-manager.js';
import type { ExperimentRecord, ExperimentResolution } from '../src/types.js';
import { Notebook } from '../src/storage/notebook.js';
import { cleanupDir, createGitRepo, pathExists, waitFor } from '../test-support/helpers.js';

function createManager(
  repoDir: string,
  notebook: Notebook,
  startSubagent: (experiment: ExperimentRecord, manager: ExperimentManager) => Promise<void>,
  resolved: ExperimentResolution[] = [],
  budgetNotifications: string[] = []
): ExperimentManager {
  let manager: ExperimentManager;
  manager = new ExperimentManager({
    cwd: repoDir,
    stateDir: path.join(repoDir, '.h2', 'worktrees'),
    notebook,
    onChange() {},
    onBudgetExceeded(notification) {
      budgetNotifications.push(notification.message);
    },
    onQualitySignal() {},
    onResolved(resolution) {
      resolved.push(resolution);
    },
    startSubagent: (experiment) => startSubagent(experiment, manager)
  });
  return manager;
}

test('ExperimentManager spawn creates worktree and persists a running record', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);
  const debt = notebook.openStudyDebt({
    sessionId: 'session-test',
    summary: 'repo safety is unproven',
    whyItMatters: 'Being wrong would change whether the experiment should run.',
    kind: 'architecture'
  });

  let started = false;
  const manager = createManager(repoDir, notebook, async () => {
    started = true;
  });
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    studyDebtId: debt.id,
    hypothesis: 'investigate the repo safely',
    localEvidenceSummary: 'The repo is available and an isolated worktree can be created.',
    residualUncertainty: 'Whether the isolated study can inspect the repo safely.',
    budgetTokens: 1200,
    preserve: false
  });

  assert.equal(started, true);
  assert.equal(await pathExists(experiment.worktreePath), true);
  assert.equal(manager.read(experiment.id).status, 'running');
  assert.equal(manager.read(experiment.id).studyDebtId, debt.id);
  assert.equal(notebook.getExperiment(experiment.id)?.hypothesis, 'investigate the repo safely');
});

test('ExperimentManager spawn mirrors repo-local env files into the experiment worktree', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  await writeFile(path.join(repoDir, '.env.local'), 'OPENAI_API_KEY=root-secret\n', 'utf8');
  await mkdir(path.join(repoDir, 'apps', 'web'), { recursive: true });
  await writeFile(
    path.join(repoDir, 'apps', 'web', '.env.development.local'),
    'NEXT_PUBLIC_API_URL=http://localhost:3000\n',
    'utf8'
  );
  await mkdir(path.join(repoDir, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(repoDir, 'node_modules', 'pkg', '.env.local'), 'SHOULD_NOT_COPY=1\n', 'utf8');

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const manager = createManager(repoDir, notebook, async () => {});
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'env mirroring works',
    localEvidenceSummary: 'Repo-local env files exist in root and nested app paths.',
    residualUncertainty: 'Whether experiment worktrees receive the same repo-local env files.',
    budgetTokens: 1200,
    preserve: false
  });

  assert.equal(
    await readFile(path.join(experiment.worktreePath, '.env.local'), 'utf8'),
    'OPENAI_API_KEY=root-secret\n'
  );
  assert.equal(
    await readFile(path.join(experiment.worktreePath, 'apps', 'web', '.env.development.local'), 'utf8'),
    'NEXT_PUBLIC_API_URL=http://localhost:3000\n'
  );
  assert.equal(await pathExists(path.join(experiment.worktreePath, 'node_modules', 'pkg', '.env.local')), false);

  const details = manager.read(experiment.id);
  assert.ok(
    details.observations.some((entry) =>
      entry.message.includes('Mirrored repo-local env files into the worktree')
    )
  );
});

test('ExperimentManager spawn mirrors the dirty workspace snapshot into the experiment worktree', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  await writeFile(path.join(repoDir, 'README.md'), '# temp repo\nupdated locally\n', 'utf8');
  await writeFile(path.join(repoDir, 'tracked.txt'), 'tracked baseline\n', 'utf8');
  await execa('git', ['add', 'tracked.txt'], { cwd: repoDir });
  await execa('git', ['commit', '-m', 'add tracked fixture'], { cwd: repoDir });

  await writeFile(path.join(repoDir, 'README.md'), '# temp repo\nupdated after commit\n', 'utf8');
  await execa('git', ['rm', '-f', 'tracked.txt'], { cwd: repoDir });
  await mkdir(path.join(repoDir, 'src', 'app', 'api', 'chats'), { recursive: true });
  await writeFile(
    path.join(repoDir, 'src', 'app', 'api', 'chats', 'route.ts'),
    'export async function GET() { return Response.json({ ok: true }); }\n',
    'utf8'
  );
  await mkdir(path.join(repoDir, '.h2'), { recursive: true });
  await writeFile(path.join(repoDir, '.h2', 'notebook.sqlite'), 'do not mirror\n', 'utf8');

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const manager = createManager(repoDir, notebook, async () => {});
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'dirty workspace snapshot is available in the experiment',
    localEvidenceSummary: 'The main workspace has tracked edits, a tracked deletion, and an untracked route file.',
    residualUncertainty: 'Whether the experiment worktree sees the same dirty snapshot as the main workspace.',
    budgetTokens: 1200,
    preserve: false
  });

  assert.equal(
    await readFile(path.join(experiment.worktreePath, 'README.md'), 'utf8'),
    '# temp repo\nupdated after commit\n'
  );
  assert.equal(await pathExists(path.join(experiment.worktreePath, 'tracked.txt')), false);
  assert.equal(
    await readFile(path.join(experiment.worktreePath, 'src', 'app', 'api', 'chats', 'route.ts'), 'utf8'),
    'export async function GET() { return Response.json({ ok: true }); }\n'
  );
  assert.equal(await pathExists(path.join(experiment.worktreePath, '.h2', 'notebook.sqlite')), false);

  const details = manager.read(experiment.id);
  assert.ok(
    details.observations.some((entry) =>
      entry.message.includes('Mirrored dirty workspace snapshot into the worktree: 2 tracked, 1 untracked file(s).')
    )
  );
});

test('ExperimentManager logObservation appends tagged notes to durable state', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const manager = createManager(repoDir, notebook, async (experiment, currentManager) => {
    await currentManager.logObservation(experiment.id, 'found the target file', ['discovery', 'promising']);
  });
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'look for a useful clue',
    localEvidenceSummary: 'The worktree can be created and the subagent can run.',
    residualUncertainty: 'Whether observations are durably recorded while the experiment is running.',
    budgetTokens: 1200,
    preserve: false
  });

  const details = await waitFor(
    () => manager.read(experiment.id),
    (value) => value.observations.some((entry) => entry.message.includes('found the target file'))
  );

  const observation = details.observations.find((entry) => entry.message.includes('found the target file'));
  assert.deepEqual(observation?.tags, ['discovery', 'promising']);
  assert.ok(details.contextTokensUsed > 0);
  assert.ok(details.observationTokensUsed > 0);
});

test('ExperimentManager resolve updates status and removes or preserves the worktree', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const resolved: ExperimentResolution[] = [];
  const manager = createManager(repoDir, notebook, async (experiment, currentManager) => {
    await currentManager.resolve({
      experimentId: experiment.id,
      verdict: 'validated',
      summary: 'safe to adopt',
      discovered: ['notes.txt changed'],
      artifacts: ['notes.txt'],
      constraints: ['review before adopt'],
      confidenceNote: 'Directly observed in worktree.',
      promote: false
    });
  }, resolved);
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'confirm worktree cleanup',
    localEvidenceSummary: 'The experiment can resolve without promotion.',
    residualUncertainty: 'Whether cleanup removes the temporary worktree after resolution.',
    budgetTokens: 1200,
    preserve: false
  });

  const firstResolution = await waitFor(
    () => manager.read(experiment.id),
    (value) => value.status !== 'running'
  );

  assert.equal(firstResolution.finalVerdict, 'validated');
  assert.equal(await pathExists(experiment.worktreePath), false);
  assert.equal(resolved[0]?.promote, false);

  const preservedManager = createManager(repoDir, notebook, async (nextExperiment, currentManager) => {
    await currentManager.resolve({
      experimentId: nextExperiment.id,
      verdict: 'validated',
      summary: 'keep this worktree for handoff',
      discovered: ['patch ready'],
      artifacts: ['patch-ready worktree'],
      constraints: ['manual inspection before adoption'],
      confidenceNote: 'Promoted for handoff.',
      promote: true
    });
  });
  t.after(async () => preservedManager.dispose());

  const preserved = await preservedManager.spawn({
    sessionId: 'session-test',
    hypothesis: 'preserve promoted result',
    localEvidenceSummary: 'Promoted experiments should preserve their worktree after resolution.',
    residualUncertainty: 'Whether promotion keeps the worktree available for later adoption.',
    budgetTokens: 1200,
    preserve: false
  });

  const secondResolution = await waitFor(
    () => preservedManager.read(preserved.id),
    (value) => value.status !== 'running'
  );

  assert.equal(secondResolution.promote, true);
  assert.equal(await pathExists(preserved.worktreePath), true);
});

test('ExperimentManager requires evidence or an explicit resolution note before resolving', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  let releaseSubagent: (() => void) | null = null;
  const manager = createManager(
    repoDir,
    notebook,
    async () =>
      new Promise<void>((resolve) => {
        releaseSubagent = resolve;
      })
  );
  t.after(async () => {
    releaseSubagent?.();
    await manager.dispose();
  });

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'check resolution hygiene',
    localEvidenceSummary: 'The worktree can be created and the experiment can start.',
    residualUncertainty: 'Whether resolve_experiment can succeed without any meaningful findings.',
    budgetTokens: 1200,
    preserve: false
  });

  await assert.rejects(
    () =>
      manager.resolve({
        experimentId: experiment.id,
        verdict: 'inconclusive',
        summary: 'No result yet.',
        discovered: [],
        promote: false
      }),
    /requires either a material observation trail or an explicit resolutionNote/i
  );

  const resolution = await manager.resolve({
    experimentId: experiment.id,
    verdict: 'inconclusive',
    summary: 'No reliable signal after the initial setup.',
    discovered: [],
    resolutionNote: 'No finding: the minimal checks produced no differentiating evidence.',
    promote: false
  });

  assert.equal(resolution.verdict, 'inconclusive');
  assert.ok(
    manager
      .read(experiment.id)
      .observations.some((entry) => entry.message.includes('Resolution note: No finding'))
  );
});

test('ExperimentManager pauses and notifies when the budget is exhausted', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const resolved: ExperimentResolution[] = [];
  const budgetNotifications: string[] = [];
  const manager = createManager(repoDir, notebook, async (experiment, currentManager) => {
    await currentManager.logObservation(
      experiment.id,
      'x'.repeat(2000),
      ['blocker']
    );
  }, resolved, budgetNotifications);
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'force budget exhaustion',
    localEvidenceSummary: 'The experiment can emit large observations repeatedly.',
    residualUncertainty: 'Whether the manager pauses the experiment when the budget is exceeded.',
    budgetTokens: 300,
    preserve: false
  });

  const details = await waitFor(
    () => manager.read(experiment.id),
    (value) => value.status !== 'running'
  );

  assert.equal(details.status, 'budget_exhausted');
  assert.equal(details.finalVerdict, null);
  assert.equal(details.finalSummary, null);
  assert.ok(details.observations.some((entry) => entry.message.includes('Budget exhausted')));
  assert.equal(resolved.length, 0);
  assert.equal(budgetNotifications.length, 1);
  assert.ok(details.observationTokensUsed > 0);
});

test('ExperimentManager can extend a budget-exhausted experiment and resume it', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const resolved: ExperimentResolution[] = [];
  let runCount = 0;
  const manager = createManager(repoDir, notebook, async (experiment, currentManager) => {
    runCount += 1;
    if (runCount === 1) {
      await currentManager.logObservation(experiment.id, 'x'.repeat(2000), ['blocker']);
      return;
    }

    await currentManager.resolve({
      experimentId: experiment.id,
      verdict: 'validated',
      summary: 'continued after adding more budget',
      discovered: ['resume path works'],
      artifacts: ['resume evidence'],
      constraints: ['requires additional budget'],
      confidenceNote: 'Observed after second run.',
      promote: false
    });
  }, resolved);
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'resume after budget extension',
    localEvidenceSummary: 'A budget-exhausted experiment can be extended.',
    residualUncertainty: 'Whether extending the budget resumes the experiment correctly.',
    budgetTokens: 300,
    preserve: false
  });

  await waitFor(
    () => manager.read(experiment.id),
    (value) => value.status === 'budget_exhausted'
  );

  const resumed = await manager.extendBudget(experiment.id, 5000);
  assert.equal(resumed.budget, 5300);

  const final = await waitFor(
    () => manager.read(experiment.id),
    (value) => value.status === 'validated'
  );

  assert.equal(final.finalVerdict, 'validated');
  assert.match(final.finalSummary ?? '', /continued after adding more budget/);
  assert.equal(runCount, 2);
  assert.equal(resolved[0]?.verdict, 'validated');
});

test('ExperimentManager emits a low-signal warning after heavy tool output without findings', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const qualityNotifications: string[] = [];
  const manager = new ExperimentManager({
    cwd: repoDir,
    stateDir: path.join(repoDir, '.h2', 'worktrees'),
    notebook,
    onChange() {},
    onBudgetExceeded() {},
    onQualitySignal(notification) {
      qualityNotifications.push(notification.message);
    },
    onResolved() {},
    startSubagent: async (experiment) => {
      await manager.recordToolUsage(experiment.id, 'x'.repeat(6_000));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'warn on low-signal probing',
    localEvidenceSummary: 'The experiment can consume substantial tool-output budget.',
    residualUncertainty: 'Whether low-signal probing triggers the quality warning.',
    budgetTokens: 10_000,
    preserve: false
  });

  const details = await waitFor(
    () => manager.read(experiment.id),
    (value) => value.lowSignalWarningEmitted
  );

  assert.equal(details.lowSignalWarningEmitted, true);
  assert.ok(
    details.observations.some((entry) => entry.message.includes('Low-signal warning'))
  );
  assert.equal(qualityNotifications.length, 1);
});

test('ExperimentManager waitForResolution returns timedOut when an experiment is still running', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const manager = createManager(repoDir, notebook, async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'wait should time out cleanly',
    localEvidenceSummary: 'The experiment remains running long enough to wait on it.',
    residualUncertainty: 'Whether waitForResolution reports a timeout cleanly.',
    budgetTokens: 1200,
    preserve: false
  });

  const result = await manager.waitForResolution(experiment.id, 50);
  assert.equal(result.timedOut, true);
  assert.equal(result.status, 'running');
  assert.equal(result.experimentId, experiment.id);
  assert.equal(typeof result.lastObservationSnippet, 'string');
  assert.equal('observations' in result, false);
});

test('ExperimentManager waitForResolution returns the resolved experiment when it finishes in time', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  const manager = createManager(repoDir, notebook, async (experiment, currentManager) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await currentManager.resolve({
      experimentId: experiment.id,
      verdict: 'validated',
      summary: 'finished while waiting',
      discovered: ['resolved in wait window'],
      artifacts: ['wait resolution'],
      constraints: [],
      confidenceNote: 'Resolved during bounded wait.',
      promote: false
    });
  });
  t.after(async () => manager.dispose());

  const experiment = await manager.spawn({
    sessionId: 'session-test',
    hypothesis: 'wait should observe resolution',
    localEvidenceSummary: 'The experiment can resolve within the timeout window.',
    residualUncertainty: 'Whether waitForResolution returns the resolved experiment result.',
    budgetTokens: 1200,
    preserve: false
  });

  const result = await manager.waitForResolution(experiment.id, 500);
  assert.equal(result.timedOut, false);
  assert.equal(result.status, 'validated');
  assert.equal(result.summary, 'finished while waiting');
  assert.deepEqual(result.discovered, ['resolved in wait window']);
});

test('ExperimentManager allows up to five concurrent experiments and rejects the sixth', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'test.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', repoDir);

  let releaseRunning: (() => void) | undefined;
  const runningBlocker = new Promise<void>((resolve) => {
    releaseRunning = resolve;
  });

  const manager = createManager(repoDir, notebook, async () => {
    await runningBlocker;
  });
  t.after(async () => {
    releaseRunning?.();
    await manager.dispose();
  });

  const experiments = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      manager.spawn({
        sessionId: 'session-test',
        hypothesis: `concurrency slot ${index + 1}`,
        localEvidenceSummary: 'Fewer than five experiments are currently running.',
        residualUncertainty: 'Whether this slot can be allocated without violating the concurrency cap.',
        budgetTokens: 1200,
        preserve: false
      })
    )
  );

  assert.equal(experiments.length, 5);

  await assert.rejects(
    () =>
      manager.spawn({
        sessionId: 'session-test',
        hypothesis: 'should exceed the concurrency limit',
        localEvidenceSummary: 'Five experiments are already running.',
        residualUncertainty: 'Whether the manager rejects the sixth concurrent experiment.',
        budgetTokens: 1200,
        preserve: false
      }),
    /Only 5 experiments can run at a time/
  );
});
