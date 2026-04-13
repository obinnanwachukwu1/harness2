import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  OPENAI_CODEX_ORIGINATOR,
  OPENAI_CODEX_PROVIDER,
  OPENAI_CODEX_RESPONSES_ENDPOINT,
  OpenAICodexAuth
} from '../src/auth/openai-codex.js';
import {
  ModelClient,
  DIRECT_TOOL_DEFINITIONS,
  EXPERIMENT_TOOL_DEFINITIONS,
  STUDY_TOOL_DEFINITIONS
} from '../src/model/model-client.js';
import { resetModelsDevCatalogForTests } from '../src/model/models-dev.js';
import {
  DIRECT_AGENT_PROMPT,
  EXPERIMENT_SUBAGENT_PROMPT,
  STUDY_AGENT_PROMPT
} from '../src/model/model-prompt.js';
import { Notebook } from '../src/storage/notebook.js';
import type { AgentTools, TranscriptRole } from '../src/types.js';
import { cleanupDir, createTempDir, createUnsignedJwt } from '../test-support/helpers.js';

function createResponsesStream(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  );
}

function responseCreated(id: string, model = 'gpt-5.4') {
  return {
    type: 'response.created',
    response: {
      id,
      created_at: 1_700_000_000,
      model,
      service_tier: null
    }
  };
}

function responseCompleted(id: string, model = 'gpt-5.4') {
  return {
    type: 'response.completed',
    response: {
      id,
      created_at: 1_700_000_000,
      model,
      service_tier: null,
      incomplete_details: null,
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 }
      }
    }
  };
}

function functionCallDone(
  callId: string,
  name: string,
  input: Record<string, unknown>,
  outputIndex = 0
) {
  return {
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      type: 'function_call',
      id: `fc_${callId}`,
      call_id: callId,
      name,
      arguments: JSON.stringify(input),
      status: 'completed'
    }
  };
}

function webSearchCallDone(
  id: string,
  query: string,
  sources: Array<{ type: 'url'; url: string }> = [{ type: 'url', url: 'https://example.com' }],
  outputIndex = 0
) {
  return {
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      type: 'web_search_call',
      id,
      status: 'completed',
      action: {
        type: 'search',
        query
      },
      sources
    }
  };
}

function webSearchCallDoneWithoutQuery(
  id: string,
  sources: Array<{ type: 'url'; url: string }> = [{ type: 'url', url: 'https://example.com' }],
  outputIndex = 0
) {
  return {
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      type: 'web_search_call',
      id,
      status: 'completed',
      sources
    }
  };
}

function webSearchCallAdded(id: string, outputIndex = 0) {
  return {
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: {
      type: 'web_search_call',
      id,
      status: 'in_progress'
    }
  };
}

async function runTurn(
  client: ModelClient,
  sessionId: string,
  inputText: string,
  tools: AgentTools,
  emit: (role: TranscriptRole, text: string) => Promise<void>,
  ...legacyOptionalArgs: any[]
) {
  const [
    onAssistantStream,
    onReasoningSummaryStream,
    thinkingEnabled,
    abortSignal,
    webSearchMode,
    toolDefinitions,
    instructions,
    onToolCallStart,
    onToolCallFinish,
    allowHiddenAutoCompaction,
    getHiddenCompactionState,
    consumeQueuedUserMessages
  ] = legacyOptionalArgs;

  const resolvedWebSearchMode =
    typeof webSearchMode === 'string' ? webSearchMode : undefined;
  let resolvedToolDefinitions =
    Array.isArray(webSearchMode)
      ? webSearchMode
      : Array.isArray(toolDefinitions)
        ? toolDefinitions
        : undefined;
  let resolvedInstructions = typeof instructions === 'string' ? instructions : undefined;
  let resolvedOnToolCallStart = onToolCallStart;
  let resolvedOnToolCallFinish = onToolCallFinish;

  if (typeof toolDefinitions === 'function') {
    resolvedOnToolCallStart = toolDefinitions;
    resolvedOnToolCallFinish =
      typeof instructions === 'function' ? instructions : onToolCallStart;
    resolvedInstructions = undefined;
    resolvedToolDefinitions = undefined;
  } else if (typeof instructions === 'function') {
    resolvedOnToolCallStart = instructions;
    resolvedOnToolCallFinish = onToolCallStart;
    resolvedInstructions = undefined;
  }

  return client.runTurn({
    sessionId,
    inputText,
    tools,
    emit,
    onAssistantStream,
    onReasoningSummaryStream,
    thinkingEnabled,
    abortSignal,
    webSearchMode: resolvedWebSearchMode,
    toolDefinitions: resolvedToolDefinitions,
    instructions: resolvedInstructions,
    onToolCallStart: resolvedOnToolCallStart,
    onToolCallFinish: resolvedOnToolCallFinish,
    allowHiddenAutoCompaction,
    getHiddenCompactionState,
    consumeQueuedUserMessages
  });
}

test('ModelClient performs tool round-trips and persists the latest response id', async (t) => {
  const tempDir = await createTempDir('h2-model-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: OPENAI_CODEX_PROVIDER,
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  let responseCount = 0;
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body
      });

      responseCount += 1;
      if (responseCount === 1) {
        return createResponsesStream([
          responseCreated('resp_1'),
          functionCallDone('call_1', 'read', { path: 'README.md' }),
          responseCompleted('resp_1')
        ]);
      }

      return createResponsesStream([
        responseCreated('resp_2'),
        {
          type: 'response.output_text.delta',
          item_id: 'msg_2',
          delta: 'Done reading the file.'
        },
        responseCompleted('resp_2')
      ]);
    }
  });

  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const streamed: string[] = [];
  const liveToolEvents: Array<{ phase: 'start' | 'finish'; toolCallId: string; toolName?: string; label?: string }> =
    [];
  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async (filePath) => `read ${filePath}`,
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'Read the readme',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    },
    async (text) => {
      streamed.push(text);
    },
    undefined,
    false,
    undefined,
    undefined,
    async (toolCall) => {
      liveToolEvents.push({
        phase: 'start',
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        label: toolCall.label
      });
    },
    async (toolCallId) => {
      liveToolEvents.push({
        phase: 'finish',
        toolCallId
      });
    }
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, OPENAI_CODEX_RESPONSES_ENDPOINT);
  assert.equal(requests[0]?.headers.get('originator'), OPENAI_CODEX_ORIGINATOR);
  assert.equal(requests[0]?.headers.get('chatgpt-account-id'), 'acct_123');
  assert.equal(requests[0]?.headers.get('session_id'), 'session-test');
  assert.equal(requests[0]?.body.model, 'gpt-5.4');
  assert.equal(requests[0]?.body.stream, true);
  assert.equal(requests[0]?.body.prompt_cache_key, 'session-test');
  assert.equal('previous_response_id' in (requests[0]?.body ?? {}), false);
  assert.deepEqual(requests[0]?.body.reasoning, { effort: 'medium' });
  assert.equal(requests[1]?.body.prompt_cache_key, 'session-test');
  assert.equal('previous_response_id' in (requests[1]?.body ?? {}), false);
  assert.deepEqual(requests[1]?.body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'Read the readme' }] },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'read',
      arguments: '{"path":"README.md"}'
    },
    { type: 'function_call_output', call_id: 'call_1', output: 'read README.md' }
  ]);

  assert.equal(notebook.getModelSession('session-test')?.previousResponseId, 'resp_2');
  assert.deepEqual(notebook.listModelUsage('session-test').map((entry) => ({
    responseId: entry.responseId,
    inputTokens: entry.inputTokens,
    cachedInputTokens: entry.cachedInputTokens,
    outputTokens: entry.outputTokens,
    reasoningTokens: entry.reasoningTokens,
    totalTokens: entry.totalTokens
  })), [
    {
      responseId: 'resp_1',
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2
    },
    {
      responseId: 'resp_2',
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2
    }
  ]);
  assert.deepEqual(notebook.getModelUsageSummary('session-test'), {
    responseCount: 2,
    inputTokens: 2,
    cachedInputTokens: 0,
    outputTokens: 2,
    reasoningTokens: 0,
    totalTokens: 4,
    maxInputTokens: 1,
    maxOutputTokens: 1,
    maxTotalTokens: 2
  });
  assert.deepEqual(streamed, ['Done reading the file.']);
  assert.deepEqual(liveToolEvents, [
    {
      phase: 'start',
      toolCallId: 'call_1',
      toolName: 'read',
      label: 'Read(README.md)'
    },
    {
      phase: 'finish',
      toolCallId: 'call_1'
    }
  ]);
  assert.equal(emitted[0]?.role, 'tool');
  assert.match(emitted[0]?.text ?? '', /^@@tool\tread\tRead\(README\.md\)/);
  assert.equal(emitted[1]?.role, 'assistant');
  assert.equal(emitted[1]?.text, 'Done reading the file.');
});

test('ModelClient auto-compacts direct mode with a hidden checkpoint before the model turn', async (t) => {
  const priorContextWindow = process.env.H2_CONTEXT_WINDOW_TOKENS;
  process.env.H2_CONTEXT_WINDOW_TOKENS = '12000';
  t.after(() => {
    if (priorContextWindow === undefined) {
      delete process.env.H2_CONTEXT_WINDOW_TOKENS;
    } else {
      process.env.H2_CONTEXT_WINDOW_TOKENS = priorContextWindow;
    }
  });

  const tempDir = await createTempDir('h2-model-hidden-compact-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-compact', tempDir);
  notebook.upsertModelSession({
    sessionId: 'session-compact',
    provider: 'openai-codex',
    model: 'gpt-5.4',
    reasoningEffort: 'medium',
    previousResponseId: null,
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    agentMode: 'direct',
    planModePhase: null
  });
  notebook.appendModelHistoryItem('session-compact', {
    type: 'message',
    role: 'user',
    content: 'old context '.repeat(2000)
  });
  notebook.appendModelHistoryItem('session-compact', {
    type: 'message',
    role: 'assistant',
    content: 'implementation details '.repeat(600)
  });

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const requests: Array<{ body: Record<string, unknown> }> = [];
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ body });

      if (body.model === 'gpt-5.4-mini') {
        const summary = {
          mode: 'direct',
          task: {
            goal: 'Continue the direct-mode task after hidden compaction.',
            constraints: ['keep the change minimal'],
            non_goals: ['no feature expansion']
          },
          state: {
            status: 'in_progress',
            completed: ['Inspected the existing code and identified the touched area.'],
            current_focus: 'Finish the requested direct-mode update.',
            next: ['Apply the remaining edit.', 'Run one focused validation check.'],
            blockers: []
          },
          durable_decisions: [
            {
              decision: 'Keep the implementation local to the existing file.',
              why: 'The saved history already narrowed the scope.'
            }
          ],
          implementation_context: {
            changed_files: ['src/server.js'],
            relevant_paths: ['src/server.js'],
            artifacts: []
          },
          validation: {
            last_test_status: null,
            passed_checks: [],
            open_failures: []
          },
          plan_mode_state: null,
          resume_hints: ['Use the checkpoint block plus raw tail to continue.']
        };

        return createResponsesStream([
          responseCreated('resp_compact', 'gpt-5.4-mini'),
          {
            type: 'response.output_text.delta',
            item_id: 'msg_compact',
            delta: JSON.stringify(summary)
          },
          responseCompleted('resp_compact', 'gpt-5.4-mini')
        ]);
      }

      return createResponsesStream([
        responseCreated('resp_final'),
        {
          type: 'response.output_text.delta',
          item_id: 'msg_final',
          delta: 'Done after hidden compaction.'
        },
        responseCompleted('resp_final')
      ]);
    }
  });

  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  await runTurn(client, 
    'session-compact',
    'Finish the direct update',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    },
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    DIRECT_TOOL_DEFINITIONS,
    DIRECT_AGENT_PROMPT,
    undefined,
    undefined,
    true
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.body.model, 'gpt-5.4-mini');
  assert.equal(requests[1]?.body.model, 'gpt-5.4');
  const firstInput = (requests[1]?.body.input as Array<Record<string, unknown>>)[0] as
    | { role?: string; content?: unknown }
    | undefined;
  assert.equal(firstInput?.role, 'developer');
  assert.match(String(firstInput?.content ?? ''), /Hidden continuation summary/);
  assert.equal(notebook.getLatestSessionCheckpoint('session-compact')?.checkpointKind, 'plan_direct');
  assert.ok(
    (notebook.getLatestSessionCheckpoint('session-compact')?.checkpointSummary?.task.goal ?? '').includes(
      'Continue the direct-mode task'
    )
  );
  assert.equal(emitted.at(-1)?.text, 'Done after hidden compaction.');
});

test('ModelClient auto-compacts experiment subagents against the model context window', async (t) => {
  const priorContextWindow = process.env.H2_CONTEXT_WINDOW_TOKENS;
  process.env.H2_CONTEXT_WINDOW_TOKENS = '12000';
  t.after(() => {
    if (priorContextWindow === undefined) {
      delete process.env.H2_CONTEXT_WINDOW_TOKENS;
    } else {
      process.env.H2_CONTEXT_WINDOW_TOKENS = priorContextWindow;
    }
  });

  const tempDir = await createTempDir('h2-model-hidden-experiment-compact-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('experiment-session', tempDir);
  notebook.appendModelHistoryItem('experiment-session', {
    type: 'message',
    role: 'user',
    content: 'run a bounded experiment '.repeat(1800)
  });
  notebook.appendModelHistoryItem('experiment-session', {
    type: 'message',
    role: 'assistant',
    content: 'experiment observations '.repeat(650)
  });

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const requests: Array<{ body: Record<string, unknown> }> = [];
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ body });

      if (body.model === 'gpt-5.4-mini') {
        const summary = {
          mode: 'experiment',
          task: {
            goal: 'Validate the bounded experiment after hidden compaction.',
            constraints: ['stay inside the experiment worktree', 'do not broaden scope'],
            non_goals: ['do not implement the main-task feature']
          },
          state: {
            status: 'in_progress',
            completed: ['Re-read the scoped experiment context and prior observations.'],
            current_focus: 'Finish validating the current hypothesis.',
            next: ['Run one final targeted validation.', 'Resolve the experiment once evidence is sufficient.'],
            blockers: []
          },
          durable_decisions: [
            {
              decision: 'Keep the work bounded to the isolated experiment.',
              why: 'The experiment remains a scoped validation task.'
            }
          ],
          implementation_context: {
            changed_files: [],
            relevant_paths: ['.h2/worktrees/exp-1'],
            artifacts: []
          },
          validation: {
            last_test_status: null,
            passed_checks: [],
            open_failures: []
          },
          plan_mode_state: null,
          resume_hints: ['Continue the bounded experiment from the hidden checkpoint.']
        };

        return createResponsesStream([
          responseCreated('resp_exp_compact', 'gpt-5.4-mini'),
          {
            type: 'response.output_text.delta',
            item_id: 'msg_exp_compact',
            delta: JSON.stringify(summary)
          },
          responseCompleted('resp_exp_compact', 'gpt-5.4-mini')
        ]);
      }

      return createResponsesStream([
        responseCreated('resp_exp_final'),
        {
          type: 'response.output_text.delta',
          item_id: 'msg_exp_final',
          delta: 'Experiment continued after hidden compaction.'
        },
        responseCompleted('resp_exp_final')
      ]);
    }
  });

  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    logObservation: async () => '',
    resolveExperiment: async () => ({} as any),
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  await runTurn(client, 
    'experiment-session',
    'Continue the bounded experiment',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    },
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    EXPERIMENT_TOOL_DEFINITIONS,
    EXPERIMENT_SUBAGENT_PROMPT,
    undefined,
    undefined,
    true,
    async () => ({
      mode: 'experiment',
      planModePhase: null,
      approvedPlan: null,
      todos: [],
      lastTestStatus: null,
      activeProcessSummary: [],
      experimentState: {
        id: 'exp-1',
        hypothesis: 'sqlite claim remains safe under contention',
        budget: 25,
        tokensUsed: 3,
        worktreePath: path.join(tempDir, '.h2', 'worktrees', 'exp-1'),
        branchName: 'h2-exp-1'
      }
    })
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.body.model, 'gpt-5.4-mini');
  assert.equal(requests[1]?.body.model, 'gpt-5.4');
  assert.equal(
    notebook.getLatestSessionCheckpoint('experiment-session')?.checkpointKind,
    'experiment_subagent'
  );
  assert.equal(
    notebook.getLatestSessionCheckpoint('experiment-session')?.checkpointSummary?.mode,
    'experiment'
  );
  assert.ok(
    (notebook.getLatestSessionCheckpoint('experiment-session')?.checkpointSummary?.task.goal ?? '').includes(
      'bounded experiment'
    )
  );
  assert.equal(emitted.at(-1)?.text, 'Experiment continued after hidden compaction.');
});

test('ModelClient sends the built-in web_search tool when enabled', async (t) => {
  const priorMode = process.env.H2_WEB_SEARCH_MODE;
  process.env.H2_WEB_SEARCH_MODE = 'cached';
  t.after(() => {
    if (priorMode === undefined) {
      delete process.env.H2_WEB_SEARCH_MODE;
    } else {
      process.env.H2_WEB_SEARCH_MODE = priorMode;
    }
  });

  const tempDir = await createTempDir('h2-model-web-search-request-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const requests: Array<Record<string, unknown>> = [];
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return createResponsesStream([
        responseCreated('resp_1'),
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          delta: 'Used web search.'
        },
        responseCompleted('resp_1')
      ]);
    }
  });

  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 'session-test', 'Find recent news.', tools, async () => {});

  const requestTools = requests[0]?.tools as Array<Record<string, unknown>>;
  const webSearchTool = requestTools.find((tool) => tool.type === 'web_search');
  assert.deepEqual(webSearchTool, {
    type: 'web_search',
    external_web_access: false,
    search_context_size: 'medium'
  });
});

test('ModelClient does not route provider-executed web search through the local tool loop', async (t) => {
  const priorMode = process.env.H2_WEB_SEARCH_MODE;
  process.env.H2_WEB_SEARCH_MODE = 'cached';
  t.after(() => {
    if (priorMode === undefined) {
      delete process.env.H2_WEB_SEARCH_MODE;
    } else {
      process.env.H2_WEB_SEARCH_MODE = priorMode;
    }
  });

  const tempDir = await createTempDir('h2-model-web-search-provider-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async () =>
      createResponsesStream([
        responseCreated('resp_1'),
        webSearchCallAdded('ws_1'),
        webSearchCallDone('ws_1', 'weather seattle'),
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          delta: 'It is rainy.'
        },
        responseCompleted('resp_1')
      ])
  });

  let localToolExecutions = 0;
  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const liveToolEvents: Array<{ phase: 'start' | 'finish'; toolCallId: string; toolName?: string }> = [];
  const tools: AgentTools = {
    execCommand: async () => {
      localToolExecutions += 1;
      return '';
    },
    writeStdin: async () => '',
    read: async () => {
      localToolExecutions += 1;
      return '';
    },
    write: async () => {
      localToolExecutions += 1;
      return '';
    },
    edit: async () => {
      localToolExecutions += 1;
      return '';
    },
    glob: async () => {
      localToolExecutions += 1;
      return [];
    },
    grep: async () => {
      localToolExecutions += 1;
      return '';
    },
    spawnExperiment: async () => {
      localToolExecutions += 1;
      throw new Error('not used');
    },
    readExperiment: async () => {
      localToolExecutions += 1;
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'Check the weather.',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    },
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    async (toolCall) => {
      liveToolEvents.push({
        phase: 'start',
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      });
    },
    async (toolCallId) => {
      liveToolEvents.push({
        phase: 'finish',
        toolCallId
      });
    }
  );

  assert.equal(localToolExecutions, 0);
  assert.deepEqual(liveToolEvents, [
    {
      phase: 'start',
      toolCallId: 'ws_1',
      toolName: 'web_search'
    },
    {
      phase: 'finish',
      toolCallId: 'ws_1'
    }
  ]);
  assert.equal(emitted.filter((entry) => entry.role === 'tool').length, 1);
  assert.equal(emitted[0]?.role, 'tool');
  assert.match(emitted[0]?.text ?? '', /^@@tool\tweb_search\tWebSearch\(weather seattle\)/);
  assert.equal(emitted[1]?.role, 'assistant');
  assert.equal(emitted[1]?.text, 'It is rainy.');
});

test('ModelClient does not leak provider web search fallback text when query metadata is missing', async (t) => {
  const tempDir = await createTempDir('h2-model-provider-search-fallback-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async () =>
      createResponsesStream([
        responseCreated('resp_1'),
        webSearchCallAdded('ws_1', 0),
        webSearchCallDoneWithoutQuery('ws_1', [{ type: 'url', url: 'https://react.dev/blog' }], 0),
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          output_index: 1,
          delta: 'Done.'
        },
        responseCompleted('resp_1')
      ])
  });

  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async () => '',
    ls: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => '',
    readExperiment: async () => '',
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'Search the web.',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    },
    undefined,
    undefined,
    false
  );

  assert.equal(emitted[0]?.role, 'tool');
  assert.equal(
    emitted[0]?.text,
    '@@tool\tweb_search\tWebSearch\nsources: none returned'
  );
});

test('ModelClient executes independent read-only tool calls in parallel while preserving output order', async (t) => {
  const tempDir = await createTempDir('h2-model-parallel-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  let responseCount = 0;
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async () => {
      responseCount += 1;
      if (responseCount === 1) {
        return createResponsesStream([
          responseCreated('resp_1'),
          functionCallDone('call_read', 'read', { path: 'README.md' }, 0),
          functionCallDone('call_rg', 'rg', { pattern: 'session', target: 'src' }, 1),
          responseCompleted('resp_1')
        ]);
      }

      return createResponsesStream([
        responseCreated('resp_2'),
        {
          type: 'response.output_text.delta',
          item_id: 'msg_2',
          delta: 'Done.'
        },
        responseCompleted('resp_2')
      ]);
    }
  });

  const toolEvents: string[] = [];
  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async (filePath) => {
      toolEvents.push(`start:read:${filePath}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
      toolEvents.push(`end:read:${filePath}`);
      return `read ${filePath}`;
    },
    ls: async () => '',
    edit: async () => '',
    glob: async () => [],
    rg: async (pattern, target) => {
      toolEvents.push(`start:rg:${pattern}:${target}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      toolEvents.push(`end:rg:${pattern}:${target}`);
      return `rg ${pattern} ${target}`;
    },
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'Read the readme and search src for session references',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    }
  );

  assert.deepEqual(toolEvents.slice(0, 4), [
    'start:read:README.md',
    'start:rg:session:src',
    'end:rg:session:src',
    'end:read:README.md'
  ]);
  assert.equal(emitted[0]?.role, 'tool');
  assert.match(emitted[0]?.text ?? '', /^@@tool\tread\tRead\(README\.md\)/);
  assert.equal(emitted[1]?.role, 'tool');
  assert.match(emitted[1]?.text ?? '', /^@@tool\trg\tRg\(session in src\)/);
});

test('ModelClient surfaces streaming assistant deltas before completion', async (t) => {
  const tempDir = await createTempDir('h2-model-stream-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async () =>
      createResponsesStream([
        responseCreated('resp_1'),
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          delta: 'Hello'
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          delta: ' world'
        },
        responseCompleted('resp_1')
      ])
  });

  const streamed: string[] = [];
  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'hello',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    },
    async (text) => {
      streamed.push(text);
    }
  );

  assert.deepEqual(streamed, ['Hello', 'Hello world']);
  assert.equal(emitted[0]?.role, 'assistant');
  assert.equal(emitted[0]?.text, 'Hello world');
});

test('ModelClient injects an observation hint for experiment subagents after several tool calls without logging', async (t) => {
  const tempDir = await createTempDir('h2-model-observation-hint-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const requests: Array<Record<string, unknown>> = [];
  let responseCount = 0;
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      responseCount += 1;

      if (responseCount === 1) {
        return createResponsesStream([
          responseCreated('resp_1'),
          functionCallDone('call_read_1', 'read', { path: 'a.ts' }, 0),
          functionCallDone('call_grep_1', 'grep', { pattern: 'foo' }, 1),
          responseCompleted('resp_1')
        ]);
      }

      if (responseCount === 2) {
        return createResponsesStream([
          responseCreated('resp_2'),
          functionCallDone('call_exec_1', 'exec_command', { command: 'pwd' }, 0),
          functionCallDone('call_glob_1', 'glob', { pattern: '*.ts' }, 1),
          responseCompleted('resp_2')
        ]);
      }

      return createResponsesStream([
        responseCreated('resp_3'),
        { type: 'response.output_text.delta', item_id: 'msg_3', delta: 'Done.' },
        responseCompleted('resp_3')
      ]);
    }
  });

  const tools: AgentTools = {
    execCommand: async () => 'pwd',
    writeStdin: async () => '',
    read: async () => 'read result',
    write: async () => '',
    edit: async () => '',
    glob: async () => ['a.ts'],
    grep: async () => 'grep result',
    readExperiment: async () => {
      throw new Error('not used');
    },
    logObservation: async () => {
      throw new Error('not used');
    },
    resolveExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'Run a scoped experiment in the isolated worktree.',
    tools,
    async () => {},
    undefined,
    undefined,
    false,
    undefined,
    EXPERIMENT_TOOL_DEFINITIONS
  );

  assert.equal(requests.length, 3);
  const thirdInput = requests[2]?.input as Array<Record<string, unknown>>;
  assert.equal(thirdInput[0]?.role, 'developer');
  assert.match(
    String(thirdInput[0]?.content ?? ''),
    /log one belief-changing observation or blocker before doing much more experiment work/i
  );
});

test('ModelClient surfaces streaming content-part events before completion', async (t) => {
  const tempDir = await createTempDir('h2-model-stream-parts-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async () =>
      createResponsesStream([
        responseCreated('resp_1'),
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          delta: 'Draft text'
        },
        responseCompleted('resp_1')
      ])
  });

  const streamed: string[] = [];
  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'hello',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    },
    async (text) => {
      streamed.push(text);
    }
  );

  assert.deepEqual(streamed, ['Draft text']);
  assert.equal(emitted[0]?.role, 'assistant');
  assert.equal(emitted[0]?.text, 'Draft text');
});

test('ModelClient does not duplicate live assistant text when final snapshots overlap deltas', async (t) => {
  const tempDir = await createTempDir('h2-model-stream-dedupe-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async () =>
      createResponsesStream([
        responseCreated('resp_1'),
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          delta: 'Hello'
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          delta: ' world'
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'msg_1',
            phase: null
          }
        },
        responseCompleted('resp_1')
      ])
  });

  const streamed: string[] = [];
  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'hello',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    },
    async (text) => {
      streamed.push(text);
    }
  );

  assert.deepEqual(streamed, ['Hello', 'Hello world']);
  assert.equal(emitted[0]?.role, 'assistant');
  assert.equal(emitted[0]?.text, 'Hello world');
});

test('ModelClient persists model and reasoning settings per session', async (t) => {
  const tempDir = await createTempDir('h2-model-settings-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const auth = new OpenAICodexAuth(notebook);
  const client = new ModelClient(notebook, auth);

  assert.equal(client.getSettings('session-test').model, 'gpt-5.4');
  assert.equal(client.getSettings('session-test').reasoningEffort, 'medium');

  client.setModel('session-test', 'gpt-5.4');
  client.setReasoningEffort('session-test', 'high');

  const settings = client.getSettings('session-test');
  assert.equal(settings.model, 'gpt-5.4');
  assert.equal(settings.reasoningEffort, 'high');
});

test('ModelClient rebuilds requests from latest checkpoint plus recent tail', async (t) => {
  const tempDir = await createTempDir('h2-model-compact-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  notebook.appendModelHistoryItem('session-test', {
    type: 'message',
    role: 'user',
    content: 'old context'
  });
  notebook.appendModelHistoryItem('session-test', {
    type: 'message',
    role: 'assistant',
    content: 'older answer'
  });
  notebook.appendModelHistoryItem('session-test', {
    type: 'message',
    role: 'user',
    content: 'recent user'
  });

  notebook.createSessionCheckpoint({
    sessionId: 'session-test',
    goal: 'stay concise',
    completed: 'captured old middle',
    next: 'continue from recent tail',
    gitLog: 'abc123 checkpoint',
    gitStatus: '(clean)',
    gitDiffStat: '(clean)',
    activeExperimentSummaries: [],
    invalidatedExperimentSummaries: [],
    checkpointBlock: 'Harness checkpoint block',
    tailStartHistoryId: 3
  });

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const requests: Array<Record<string, unknown>> = [];
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return createResponsesStream([
        responseCreated('resp_1'),
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'done' },
        responseCompleted('resp_1')
      ]);
    }
  });

  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 'session-test', 'ignored because history exists', tools, async () => undefined);

  assert.equal(requests.length, 1);
  assert.equal(typeof requests[0]?.instructions, 'string');
  assert.deepEqual(requests[0]?.input, [
    { role: 'developer', content: 'Harness checkpoint block' },
    { role: 'user', content: [{ type: 'input_text', text: 'recent user' }] }
  ]);
});

test('ModelClient estimates context usage from compacted replay state', async (t) => {
  resetModelsDevCatalogForTests();
  const tempDir = await createTempDir('h2-model-context-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);
  notebook.appendModelHistoryItem('session-test', {
    type: 'message',
    role: 'user',
    content: 'very old context that should be compacted away'
  });
  notebook.appendModelHistoryItem('session-test', {
    type: 'message',
    role: 'assistant',
    content: 'older answer'
  });
  notebook.appendModelHistoryItem('session-test', {
    type: 'message',
    role: 'user',
    content: 'recent tail'
  });
  notebook.createSessionCheckpoint({
    sessionId: 'session-test',
    goal: 'reduce replay',
    completed: 'stored checkpoint',
    next: 'continue',
    gitLog: 'abc123 checkpoint',
    gitStatus: '(clean)',
    gitDiffStat: '(clean)',
    activeExperimentSummaries: [],
    invalidatedExperimentSummaries: [],
    checkpointBlock: 'Checkpoint summary',
    tailStartHistoryId: 3
  });

  const auth = new OpenAICodexAuth(notebook);
  const client = new ModelClient(notebook, auth);
  const usage = client.getContextWindowUsage('session-test');

  assert.equal(usage.effectiveBudgetTokens, 200_000);
  assert.equal(usage.fullContextTokens, 1_050_000);
  assert.equal(usage.inputLimitTokens, null);
  assert.equal(usage.standardRateTokens, 200_000);
  assert.equal(usage.allowOverStandardContext, false);
  assert.ok(usage.usedTokens > 0);
  assert.ok(usage.usedTokens < 10_000);
});

test('ModelClient expands effective context budget when over-standard context is enabled', async (t) => {
  resetModelsDevCatalogForTests();
  const tempDir = await createTempDir('h2-model-context-budget-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);
  notebook.upsertModelSession({
    sessionId: 'session-test',
    provider: 'openai-codex',
    model: 'gpt-5.4',
    reasoningEffort: 'medium',
    allowOverStandardContext: true,
    previousResponseId: null,
    updatedAt: new Date().toISOString(),
    agentMode: 'study',
    planModePhase: null
  });

  const auth = new OpenAICodexAuth(notebook);
  const client = new ModelClient(notebook, auth);
  const usage = client.getContextWindowUsage('session-test');

  assert.equal(usage.effectiveBudgetTokens, 1_050_000);
  assert.equal(usage.fullContextTokens, 1_050_000);
  assert.equal(usage.inputLimitTokens, null);
  assert.equal(usage.standardRateTokens, 200_000);
  assert.equal(usage.allowOverStandardContext, true);
});

test('ModelClient allows over-standard context when ALLOW_OVER_STANDARD_CONTEXT=1', async (t) => {
  resetModelsDevCatalogForTests();
  const previous = process.env.ALLOW_OVER_STANDARD_CONTEXT;
  process.env.ALLOW_OVER_STANDARD_CONTEXT = '1';
  t.after(() => {
    if (previous === undefined) {
      delete process.env.ALLOW_OVER_STANDARD_CONTEXT;
    } else {
      process.env.ALLOW_OVER_STANDARD_CONTEXT = previous;
    }
  });

  const tempDir = await createTempDir('h2-model-context-budget-env-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const auth = new OpenAICodexAuth(notebook);
  const client = new ModelClient(notebook, auth);
  const usage = client.getContextWindowUsage('session-test');

  assert.equal(usage.effectiveBudgetTokens, 1_050_000);
  assert.equal(usage.allowOverStandardContext, true);
});

test('ModelClient prefers models.dev metadata for effective context policy when available', async (t) => {
  resetModelsDevCatalogForTests();
  const previousForceFetch = process.env.H2_MODELS_DEV_FORCE_FETCH;
  process.env.H2_MODELS_DEV_FORCE_FETCH = '1';
  t.after(() => {
    if (previousForceFetch === undefined) {
      delete process.env.H2_MODELS_DEV_FORCE_FETCH;
    } else {
      process.env.H2_MODELS_DEV_FORCE_FETCH = previousForceFetch;
    }
  });
  const tempDir = await createTempDir('h2-model-models-dev-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const auth = new OpenAICodexAuth(notebook);
  const modelsDevPayload = {
    opencode: {
      models: [
        {
          id: 'openai/gpt-5.4',
          limit: {
            context: 1_050_000,
            input: 922_000,
            output: 128_000
          },
          cost: {
            input: 2.5,
            output: 15,
            cache_read: 0.25,
            context_over_200k: {
              input: 5,
              output: 22.5,
              cache_read: 0.5
            }
          }
        }
      ]
    }
  };

  const client = new ModelClient(notebook, auth, {
    fetchImpl: async (input) => {
      if (String(input) === 'https://models.dev/api.json') {
        return new Response(JSON.stringify(modelsDevPayload), {
          headers: { 'content-type': 'application/json' }
        });
      }

      throw new Error(`Unexpected fetch ${String(input)}`);
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const usage = client.getContextWindowUsage('session-test');

  assert.equal(usage.effectiveBudgetTokens, 200_000);
  assert.equal(usage.fullContextTokens, 1_050_000);
  assert.equal(usage.inputLimitTokens, 922_000);
  assert.equal(usage.standardRateTokens, 200_000);

  notebook.upsertModelSession({
    sessionId: 'session-test',
    provider: 'openai-codex',
    model: 'gpt-5.4',
    reasoningEffort: 'medium',
    allowOverStandardContext: true,
    previousResponseId: null,
    updatedAt: new Date().toISOString(),
    agentMode: 'study',
    planModePhase: null
  });

  const expandedUsage = client.getContextWindowUsage('session-test');
  assert.equal(expandedUsage.effectiveBudgetTokens, 922_000);
  assert.equal(expandedUsage.inputLimitTokens, 922_000);
});

test('ModelClient does not inject open question reminder developer messages into model requests', async (t) => {
  const tempDir = await createTempDir('h2-model-open-question-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);
  notebook.appendModelHistoryItem('session-test', {
    type: 'message',
    role: 'user',
    content: 'implement auth continuity'
  });
  notebook.openStudyDebt({
    sessionId: 'session-test',
    summary: 'guest-to-login continuity is unproven',
    whyItMatters: 'Being wrong would change the chosen ownership-transfer path.',
    kind: 'runtime',
    affectedPaths: ['app/(auth)', 'lib/db/queries.ts']
  });

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const requests: Array<Record<string, unknown>> = [];
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return createResponsesStream([
        responseCreated('resp_1'),
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'ack' },
        responseCompleted('resp_1')
      ]);
    }
  });

  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 'session-test', 'ignored because history exists', tools, async () => undefined);

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'implement auth continuity' }] }
  ]);
});

test('ModelClient turns tool-call failures into tool outputs so the loop can continue', async (t) => {
  const tempDir = await createTempDir('h2-model-tool-error-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const requests: Array<Record<string, unknown>> = [];
  let responseCount = 0;
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      responseCount += 1;

      if (responseCount === 1) {
        return createResponsesStream([
          responseCreated('resp_1'),
          functionCallDone('call_1', 'spawn_experiment', {
            hypothesis: 'test concurrency guard',
            localEvidenceSummary: 'The repo already points to the suspected concurrency limit.',
            residualUncertainty: 'Whether the harness will refuse a sixth concurrent experiment.',
            budgetTokens: 1200
          }),
          responseCompleted('resp_1')
        ]);
      }

      return createResponsesStream([
        responseCreated('resp_2'),
        {
          type: 'response.output_text.delta',
          item_id: 'msg_2',
          delta: 'The experiment spawn failed because the harness concurrency limit was reached.'
        },
        responseCompleted('resp_2')
      ]);
    }
  });

  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error(
        'Only 5 experiments can run at a time in v0.1. Wait for one to resolve before spawning another.'
      );
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'Try spawning an experiment',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    }
  );

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'Try spawning an experiment' }] },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'spawn_experiment',
      arguments:
        '{"hypothesis":"test concurrency guard","localEvidenceSummary":"The repo already points to the suspected concurrency limit.","residualUncertainty":"Whether the harness will refuse a sixth concurrent experiment.","budgetTokens":1200}'
    },
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: JSON.stringify(
        {
          ok: false,
          error: {
            tool: 'spawn_experiment',
            message:
              'Only 5 experiments can run at a time in v0.1. Wait for one to resolve before spawning another.'
          }
        },
        null,
        2
      )
    }
  ]);
  assert.equal(emitted[0]?.role, 'tool');
  assert.match(emitted[0]?.text ?? '', /Tool execution failed/);
  assert.match(emitted[0]?.text ?? '', /Only 5 experiments can run at a time/);
  assert.equal(emitted[1]?.role, 'assistant');
  assert.match(emitted[1]?.text ?? '', /concurrency limit was reached/);
});

test('ModelClient retries transient 500 responses before succeeding', async (t) => {
  const tempDir = await createTempDir('h2-model-retry-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  let attempts = 0;
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response('temporary server error', {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'content-type': 'text/plain' }
        });
      }

      return createResponsesStream([
        responseCreated('resp_1'),
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Recovered after retry.' },
        responseCompleted('resp_1')
      ]);
    }
  });

  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'hello',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    }
  );

  assert.equal(attempts, 3);
  assert.equal(emitted[0]?.role, 'assistant');
  assert.equal(emitted[0]?.text, 'Recovered after retry.');
});

test('ModelClient retries transient transport failures before succeeding', async (t) => {
  const tempDir = await createTempDir('h2-model-network-retry-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  let attempts = 0;
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('fetch failed: getaddrinfo EAI_AGAIN chatgpt.com'), {
          code: 'EAI_AGAIN'
        });
      }

      return createResponsesStream([
        responseCreated('resp_1'),
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          delta: 'Recovered after network retry.'
        },
        responseCompleted('resp_1')
      ]);
    }
  });

  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'hello',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    }
  );

  assert.equal(attempts, 3);
  assert.equal(emitted[0]?.role, 'assistant');
  assert.equal(emitted[0]?.text, 'Recovered after network retry.');
});

test('ModelClient records transient provider failure after retries are exhausted', async (t) => {
  const tempDir = await createTempDir('h2-model-provider-failure-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async () => {
      throw Object.assign(new Error('Cannot connect to API: getaddrinfo EAI_AGAIN chatgpt.com'), {
        code: 'EAI_AGAIN'
      });
    }
  });

  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'hello',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    }
  );

  assert.equal(emitted[0]?.role, 'system');
  assert.match(emitted[0]?.text ?? '', /@@provider_error\tkind=transient/);
  assert.equal(emitted[1]?.role, 'assistant');
  assert.match(emitted[1]?.text ?? '', /Model provider request failed after retries:/);
});

test('ModelClient preserves streamed visible text when completed payload omits output_text', async (t) => {
  const tempDir = await createTempDir('h2-model-visible-text-fallback-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async () =>
      createResponsesStream([
        responseCreated('resp_text_only'),
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hello' },
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: ' world' },
        responseCompleted('resp_text_only')
      ])
  });

  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const streamed: string[] = [];
  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'say hello',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    },
    async (text) => {
      streamed.push(text);
    }
  );

  assert.deepEqual(streamed, ['Hello', 'Hello world']);
  assert.equal(emitted[0]?.role, 'assistant');
  assert.equal(emitted[0]?.text, 'Hello world');
});

test('ModelClient reconstructs streamed tool calls when completed payload omits output items', async (t) => {
  const tempDir = await createTempDir('h2-model-stream-tools-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  let responseCount = 0;
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async () => {
      responseCount += 1;
      if (responseCount === 1) {
        return createResponsesStream([
          responseCreated('resp_1'),
          functionCallDone('call_1', 'read', { path: 'README.md' }),
          responseCompleted('resp_1')
        ]);
      }

      return createResponsesStream([
        responseCreated('resp_2'),
        { type: 'response.output_text.delta', item_id: 'msg_2', delta: 'Done.' },
        responseCompleted('resp_2')
      ]);
    }
  });

  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async (filePath) => `read ${filePath}`,
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'Read the readme',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    }
  );

  assert.equal(emitted[0]?.role, 'tool');
  assert.match(emitted[0]?.text ?? '', /^@@tool\tread\tRead\(README\.md\)/);
  assert.equal(emitted[1]?.role, 'assistant');
  assert.equal(emitted[1]?.text, 'Done.');
});

test('ModelClient formats ranged read tool headers', async (t) => {
  const tempDir = await createTempDir('h2-model-read-range-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  let responseCount = 0;
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async () => {
      responseCount += 1;
      if (responseCount === 1) {
        return createResponsesStream([
          responseCreated('resp_1'),
          functionCallDone('call_1', 'read', { path: 'README.md', startLine: 10, endLine: 20 }),
          responseCompleted('resp_1')
        ]);
      }

      return createResponsesStream([
        responseCreated('resp_2'),
        { type: 'response.output_text.delta', item_id: 'msg_2', delta: 'Done.' },
        responseCompleted('resp_2')
      ]);
    }
  });

  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const tools: AgentTools = {
    execCommand: async () => '',
    writeStdin: async () => '',
    read: async (filePath, startLine, endLine) => `read ${filePath} ${startLine}-${endLine}`,
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'Read a slice',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    }
  );

  assert.equal(emitted[0]?.role, 'tool');
  assert.match(emitted[0]?.text ?? '', /^@@tool\tread\tRead\(README\.md:10-20\)/);
});

test('ModelClient exposes only compact when the reserve buffer is exhausted', async (t) => {
  resetModelsDevCatalogForTests();
  const tempDir = await createTempDir('h2-model-compact-only-');
  t.after(async () => cleanupDir(tempDir));

  const previousContextWindow = process.env.H2_CONTEXT_WINDOW_TOKENS;
  process.env.H2_CONTEXT_WINDOW_TOKENS = '30000';
  t.after(() => {
    if (previousContextWindow === undefined) {
      delete process.env.H2_CONTEXT_WINDOW_TOKENS;
    } else {
      process.env.H2_CONTEXT_WINDOW_TOKENS = previousContextWindow;
    }
  });

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);
  notebook.appendModelHistoryItem('session-test', {
    type: 'message',
    role: 'user',
    content: 'x'.repeat(120_000)
  });

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const requests: Array<Record<string, unknown>> = [];
  let responseCount = 0;
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      responseCount += 1;

      if (responseCount === 1) {
        return createResponsesStream([
          responseCreated('resp_1'),
          functionCallDone('call_1', 'compact', {
            goal: 'stay inside the reserve',
            completed: 'captured current state',
            next: 'resume once replay is trimmed',
            currentCommitments: 'runs remain historical snapshots',
            importantNonGoals: 'do not expand scope while compacting'
          }),
          responseCompleted('resp_1')
        ]);
      }

      return createResponsesStream([
        responseCreated('resp_2'),
        { type: 'response.output_text.delta', item_id: 'msg_2', delta: 'Compacted.' },
        responseCompleted('resp_2')
      ]);
    }
  });

  let compactCalls = 0;
  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const tools: AgentTools = {
    execCommand: async () => {
      throw new Error('exec_command should not be available once compaction is forced.');
    },
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    compact: async () => {
      compactCalls += 1;
      return { ok: true, checkpointId: 1 };
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 'session-test', 'keep going', tools, async (role, text) => {
    emitted.push({ role, text });
  });

  assert.equal(compactCalls, 1);
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(requests[0]).includes('"name":"compact"'), true);
  assert.equal(JSON.stringify(requests[0]).includes('"name":"read"'), false);
  assert.ok(
    requests[0]?.input &&
      JSON.stringify(requests[0].input).includes('Only compact is available until the session checkpoints and trims replay.')
  );
  assert.equal(emitted[0]?.role, 'tool');
  assert.match(emitted[1]?.text ?? '', /Compacted/);
});

test('ModelClient does not force hidden study compaction when unresolved state is live', async (t) => {
  const tempDir = await createTempDir('h2-model-study-force-compact-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);
  const debt = notebook.openStudyDebt({
    sessionId: 'session-test',
    summary: 'continue-generation semantics remain unresolved',
    whyItMatters: 'This changes whether partial output can resume in place.',
    kind: 'runtime',
    affectedPaths: ['app/api/chat'],
    evidencePaths: ['app/api/chat']
  });
  notebook.upsertExperiment({
    id: 'exp-running',
    sessionId: 'session-test',
    studyDebtId: debt.id,
    hypothesis: 'This stack cannot resume an interrupted partial assistant message in place.',
    command: 'subagent',
    context: '',
    baseCommitSha: 'abc123',
    branchName: 'h2-exp-running',
    worktreePath: path.join(tempDir, '.h2', 'worktrees', 'exp-running'),
    status: 'running',
    budget: 5000,
    tokensUsed: 25,
    contextTokensUsed: 10,
    toolOutputTokensUsed: 10,
    observationTokensUsed: 5,
    preserve: true,
    createdAt: new Date(1_700_000_000_000).toISOString(),
    updatedAt: new Date(1_700_000_000_000).toISOString(),
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

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const requests: Array<Record<string, unknown>> = [];
  let responseCount = 0;
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      responseCount += 1;

      if (responseCount === 1) {
        return createResponsesStream([
          responseCreated('resp_1'),
          functionCallDone('call_1', 'compact', {
            goal: 'preserve unresolved-state continuity',
            completed: 'captured the current unresolved work',
            next: 'resume from the checkpoint with the same open question and experiment',
            currentCommitments: 'keep historical snapshots immutable'
          }),
          responseCompleted('resp_1')
        ]);
      }

      return createResponsesStream([
        responseCreated('resp_2'),
        { type: 'response.output_text.delta', item_id: 'msg_2', delta: 'Checkpointed unresolved state.' },
        responseCompleted('resp_2')
      ]);
    }
  });

  let compactCalls = 0;
  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const tools: AgentTools = {
    execCommand: async () => {
      throw new Error('exec_command should not be available during forced study compaction.');
    },
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    compact: async () => {
      compactCalls += 1;
      return { ok: true, checkpointId: 1 };
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 
    'session-test',
    'keep going',
    tools,
    async (role, text) => {
      emitted.push({ role, text });
    },
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    STUDY_TOOL_DEFINITIONS,
    STUDY_AGENT_PROMPT,
    undefined,
    undefined,
    false,
    async () => ({
      mode: 'direct',
      planModePhase: null,
      approvedPlan: null,
      todos: [],
      lastTestStatus: null,
      activeProcessSummary: [],
      experimentState: null
    })
  );

  assert.equal(compactCalls, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => request.model),
    ['gpt-5.4', 'gpt-5.4']
  );
  assert.equal(JSON.stringify(requests[0]).includes('"name":"compact"'), true);
  assert.equal(JSON.stringify(requests[0]).includes('"name":"read"'), true);
  assert.doesNotMatch(
    JSON.stringify(requests[0].input),
    /A checkpoint is required now to test unresolved-state continuity\./
  );
  assert.equal(notebook.getLatestSessionCheckpoint('session-test'), null);
  assert.equal(emitted[0]?.role, 'tool');
  assert.match(emitted[1]?.text ?? '', /Checkpointed unresolved state/);
});

test('ModelClient spills oversized tool outputs to disk before replaying them', async (t) => {
  const tempDir = await createTempDir('h2-model-tool-spill-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const now = 1_700_000_000_000;
  notebook.upsertOpenAICodexAuth({
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: createUnsignedJwt({
      exp: Math.floor((now + 3600_000) / 1000)
    }),
    refreshToken: 'refresh-token',
    idToken: createUnsignedJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123'
      }
    }),
    accountId: 'acct_123',
    expiresAt: now + 3600_000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  });

  const requests: Array<Record<string, unknown>> = [];
  let responseCount = 0;
  const largeOutput = '0123456789abcdef'.repeat(1_600);
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new ModelClient(notebook, auth, {
    fetchImpl: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      responseCount += 1;

      if (responseCount === 1) {
        return createResponsesStream([
          responseCreated('resp_1'),
          functionCallDone('call_1', 'exec_command', { command: 'npm test' }),
          responseCompleted('resp_1')
        ]);
      }

      return createResponsesStream([
        responseCreated('resp_2'),
        { type: 'response.output_text.delta', item_id: 'msg_2', delta: 'Done.' },
        responseCompleted('resp_2')
      ]);
    }
  });

  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const tools: AgentTools = {
    execCommand: async () => largeOutput,
    writeStdin: async () => '',
    read: async () => '',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => '',
    spawnExperiment: async () => {
      throw new Error('not used');
    },
    readExperiment: async () => {
      throw new Error('not used');
    },
    authLogin: async () => '',
    authStatus: async () => '',
    authLogout: async () => '',
    getModelSettings: async () => '',
    setModel: async () => '',
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await runTurn(client, 'session-test', 'run the command', tools, async (role, text) => {
    emitted.push({ role, text });
  });

  const secondRequest = requests[1];
  const serializedSecondRequest = JSON.stringify(secondRequest);
  assert.match(serializedSecondRequest, /\.h2\/tool-output\/session-test\//);
  const spilledPathMatch = serializedSecondRequest.match(/\.h2\/tool-output\/session-test\/[^"]+\.txt/);
  assert.ok(spilledPathMatch);
  const spilledFile = path.join(tempDir, spilledPathMatch[0]!);
  assert.equal(await readFile(spilledFile, 'utf8'), largeOutput);
  assert.equal(emitted[0]?.role, 'tool');
  assert.match(emitted[0]?.text ?? '', /Large exec_command output spilled to/);
});
