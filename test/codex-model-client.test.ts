import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { OpenAICodexAuth } from '../src/auth/openai-codex.js';
import { CodexModelClient, EXPERIMENT_TOOL_DEFINITIONS } from '../src/model/codex-client.js';
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

test('CodexModelClient performs tool round-trips and persists the latest response id', async (t) => {
  const tempDir = await createTempDir('h2-model-');
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

  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  let responseCount = 0;
  const auth = new OpenAICodexAuth(notebook, { now: () => now });
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => '',
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

  await client.runTurn(
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
  assert.equal(requests[0]?.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(requests[0]?.headers.get('originator'), 'codex_cli_rs');
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

test('CodexModelClient sends the built-in web_search tool when enabled', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => '',
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

  await client.runTurn('session-test', 'Find recent news.', tools, async () => {});

  const requestTools = requests[0]?.tools as Array<Record<string, unknown>>;
  const webSearchTool = requestTools.find((tool) => tool.type === 'web_search');
  assert.deepEqual(webSearchTool, {
    type: 'web_search',
    external_web_access: false,
    search_context_size: 'medium'
  });
});

test('CodexModelClient does not route provider-executed web search through the local tool loop', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => {
      localToolExecutions += 1;
      return '';
    },
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

  await client.runTurn(
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
  assert.equal(emitted[0]?.role, 'tool');
  assert.match(emitted[0]?.text ?? '', /^@@tool\tweb_search\tWebSearch\(weather seattle\)/);
  assert.equal(emitted[1]?.role, 'assistant');
  assert.equal(emitted[1]?.text, 'It is rainy.');
});

test('CodexModelClient does not leak provider web search fallback text when query metadata is missing', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => '',
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

  await client.runTurn(
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

test('CodexModelClient executes independent read-only tool calls in parallel while preserving output order', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => '',
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

  await client.runTurn(
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

test('CodexModelClient surfaces streaming assistant deltas before completion', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => '',
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

  await client.runTurn(
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

test('CodexModelClient injects an observation hint for experiment subagents after several tool calls without logging', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
          functionCallDone('call_bash_1', 'bash', { command: 'pwd' }, 0),
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
    bash: async () => 'pwd',
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

  await client.runTurn(
    'session-test',
    'Run a scoped experiment in the isolated worktree.',
    tools,
    async () => {},
    undefined,
    undefined,
    false,
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

test('CodexModelClient surfaces streaming content-part events before completion', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => '',
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

  await client.runTurn(
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

test('CodexModelClient does not duplicate live assistant text when final snapshots overlap deltas', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => '',
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

  await client.runTurn(
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

test('CodexModelClient persists model and reasoning settings per session', async (t) => {
  const tempDir = await createTempDir('h2-model-settings-');
  t.after(async () => cleanupDir(tempDir));

  const notebook = new Notebook(path.join(tempDir, 'notebook.sqlite'));
  t.after(() => notebook.close());
  notebook.createSession('session-test', tempDir);

  const auth = new OpenAICodexAuth(notebook);
  const client = new CodexModelClient(notebook, auth);

  assert.equal(client.getSettings('session-test').model, 'gpt-5.4');
  assert.equal(client.getSettings('session-test').reasoningEffort, 'medium');

  client.setModel('session-test', 'gpt-5.4');
  client.setReasoningEffort('session-test', 'high');

  const settings = client.getSettings('session-test');
  assert.equal(settings.model, 'gpt-5.4');
  assert.equal(settings.reasoningEffort, 'high');
});

test('CodexModelClient rebuilds requests from latest checkpoint plus recent tail', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => '',
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

  await client.runTurn('session-test', 'ignored because history exists', tools, async () => undefined);

  assert.equal(requests.length, 1);
  assert.equal(typeof requests[0]?.instructions, 'string');
  assert.deepEqual(requests[0]?.input, [
    { role: 'developer', content: 'Harness checkpoint block' },
    { role: 'user', content: [{ type: 'input_text', text: 'recent user' }] }
  ]);
});

test('CodexModelClient estimates context usage from compacted replay state', async (t) => {
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
    checkpointBlock: 'Checkpoint summary',
    tailStartHistoryId: 3
  });

  const auth = new OpenAICodexAuth(notebook);
  const client = new CodexModelClient(notebook, auth);
  const usage = client.getContextWindowUsage('session-test');

  assert.equal(usage.totalTokens, 1_050_000);
  assert.ok(usage.usedTokens > 0);
  assert.ok(usage.usedTokens < 10_000);
});

test('CodexModelClient does not inject open question reminder developer messages into model requests', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => '',
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

  await client.runTurn('session-test', 'ignored because history exists', tools, async () => undefined);

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'implement auth continuity' }] }
  ]);
});

test('CodexModelClient turns tool-call failures into tool outputs so the loop can continue', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => '',
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

  await client.runTurn(
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

test('CodexModelClient retries transient 500 responses before succeeding', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => '',
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

  await client.runTurn(
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

test('CodexModelClient preserves streamed visible text when completed payload omits output_text', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => '',
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

  await client.runTurn(
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

test('CodexModelClient reconstructs streamed tool calls when completed payload omits output items', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => '',
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

  await client.runTurn(
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

test('CodexModelClient formats ranged read tool headers', async (t) => {
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
  const client = new CodexModelClient(notebook, auth, {
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
    bash: async () => '',
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

  await client.runTurn(
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
