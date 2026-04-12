import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { writeHarborRunArtifacts, writeHarborRunPrelude } from '../src/integrations/harbor/artifacts.js';
import { nowIso } from '../src/lib/utils.js';
import { Notebook } from '../src/storage/notebook.js';
import { cleanupDir, createGitRepo, createTempDir } from '../test-support/helpers.js';

test('writeHarborRunArtifacts exports Harbor-compatible trajectory and session artifacts', async (t) => {
  const repoDir = await createGitRepo();
  t.after(async () => cleanupDir(repoDir));
  const tempDir = await createTempDir('h2-harbor-artifacts-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(repoDir, '.h2', 'notebook.sqlite'));
  t.after(() => notebook.close());

  const session = notebook.createSession('session-harbor-export', repoDir);
  const settings = notebook.getOrCreateModelSession(session.id, {
    agentMode: 'study'
  });

  notebook.appendTranscript(session.id, 'user', 'Inspect the repo and summarize it.');
  notebook.appendModelHistoryItem(session.id, {
    type: 'message',
    role: 'user',
    content: 'Inspect the repo and summarize it.'
  });
  notebook.appendTranscript(session.id, 'system', '@@thinking\tRead the README first.');
  notebook.appendModelHistoryItem(session.id, {
    type: 'function_call',
    call_id: 'call_read_1',
    name: 'read',
    arguments: JSON.stringify({
      path: 'README.md'
    })
  });
  notebook.appendModelHistoryItem(session.id, {
    type: 'function_call_output',
    call_id: 'call_read_1',
    output: '# temp repo'
  });
  notebook.appendTranscript(
    session.id,
    'tool',
    '@@tool\tread\tRead(README.md)\n# temp repo'
  );
  notebook.appendModelHistoryItem(session.id, {
    type: 'message',
    role: 'assistant',
    content: 'The repo only contains the seeded README.'
  });
  notebook.appendModelUsage({
    sessionId: session.id,
    responseId: 'resp_1',
    inputTokens: 123,
    cachedInputTokens: 23,
    outputTokens: 45,
    reasoningTokens: 5,
    totalTokens: 168
  });
  notebook.appendTranscript(session.id, 'assistant', 'The repo only contains the seeded README.');

  const outputDir = path.join(tempDir, 'agent');
  const result = await writeHarborRunArtifacts({
    cwd: repoDir,
    outputDir,
    instruction: 'Inspect the repo and summarize it.',
    sessionId: session.id,
    runtime: {
      cwd: repoDir,
      mode: 'study',
      model: settings.model,
      reasoningEffort: settings.reasoningEffort ?? 'off',
      thinking: true,
      webSearchMode: null,
      startedAt: nowIso(),
      completedAt: nowIso(),
      usage: notebook.getModelUsageSummary(session.id)
    },
    sessionSettings: settings,
    transcript: notebook.listTranscript(session.id, Number.MAX_SAFE_INTEGER),
    modelHistory: notebook.listModelHistory(session.id),
    modelUsage: notebook.listModelUsage(session.id),
    studyDebts: [],
    experiments: []
  });

  const trajectory = JSON.parse(await readFile(result.artifacts.trajectoryJsonPath, 'utf8')) as {
    schema_version: string;
    session_id: string;
    agent: { name: string };
    steps: Array<{
      step_id: number;
      source: string;
      reasoning_content?: string;
      tool_calls?: Array<{ function_name: string; arguments: Record<string, unknown> }>;
      observation?: { results: Array<{ source_call_id?: string; content?: string }> };
      message: string;
    }>;
  };

  assert.equal(trajectory.schema_version, 'ATIF-v1.6');
  assert.equal(trajectory.session_id, session.id);
  assert.equal(trajectory.agent.name, 'harness2');
  assert.equal(trajectory.steps.length, 3);
  assert.deepEqual(
    trajectory.steps.map((step) => ({
      step_id: step.step_id,
      source: step.source
    })),
    [
      { step_id: 1, source: 'user' },
      { step_id: 2, source: 'agent' },
      { step_id: 3, source: 'agent' }
    ]
  );
  assert.equal(trajectory.steps[1]?.reasoning_content, 'Read the README first.');
  assert.equal(trajectory.steps[1]?.tool_calls?.[0]?.function_name, 'read');
  assert.deepEqual(trajectory.steps[1]?.tool_calls?.[0]?.arguments, { path: 'README.md' });
  assert.equal(
    trajectory.steps[1]?.observation?.results?.[0]?.source_call_id,
    'call_read_1'
  );
  assert.equal(trajectory.steps[1]?.observation?.results?.[0]?.content, '# temp repo');
  assert.equal(
    trajectory.steps[2]?.message,
    'The repo only contains the seeded README.'
  );

  const summary = JSON.parse(await readFile(result.resultPath, 'utf8')) as {
    sessionId: string;
    runtime: { usage?: { totalTokens: number; maxTotalTokens: number } };
    artifacts: { sessionMarkdownPath: string };
  };
  const usage = JSON.parse(await readFile(result.artifacts.usageJsonPath, 'utf8')) as {
    summary: { totalTokens: number; maxTotalTokens: number };
    entries: Array<{ responseId: string | null; totalTokens: number }>;
  };
  assert.equal(summary.sessionId, session.id);
  assert.equal(summary.runtime.usage?.totalTokens, 168);
  assert.equal(usage.summary.totalTokens, 168);
  assert.equal(usage.summary.maxTotalTokens, 168);
  assert.equal(usage.entries[0]?.responseId, 'resp_1');
  assert.equal(usage.entries[0]?.totalTokens, 168);
  assert.equal(summary.artifacts.sessionMarkdownPath, result.artifacts.sessionMarkdownPath);
});

test('writeHarborRunPrelude writes early partial metadata for interrupted runs', async (t) => {
  const tempDir = await createTempDir('h2-harbor-prelude-');
  t.after(async () => cleanupDir(tempDir));

  const outputDir = path.join(tempDir, 'agent');
  const result = await writeHarborRunPrelude({
    outputDir,
    instruction: 'Fix the workspace parser.',
    sessionId: 'session-prelude',
    runtime: {
      cwd: '/app',
      mode: 'study',
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
      thinking: true,
      webSearchMode: null,
      startedAt: nowIso(),
      status: 'running',
      interruptionSignal: null
    }
  });

  const summary = JSON.parse(await readFile(result.resultPath, 'utf8')) as {
    sessionId: string;
    partial: boolean;
    runtime: { status?: string };
    artifacts: { runtimeJsonPath: string };
  };
  const runtime = JSON.parse(await readFile(result.artifacts.runtimeJsonPath, 'utf8')) as {
    status?: string;
    model: string;
  };
  const instruction = await readFile(result.artifacts.instructionPath, 'utf8');

  assert.equal(summary.sessionId, 'session-prelude');
  assert.equal(summary.partial, true);
  assert.equal(summary.runtime.status, 'running');
  assert.equal(runtime.status, 'running');
  assert.equal(runtime.model, 'gpt-5.4');
  assert.equal(instruction, 'Fix the workspace parser.\n');
});
