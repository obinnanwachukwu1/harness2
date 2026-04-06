import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { OpenAICodexAuth } from '../src/auth/openai-codex.js';
import { CodexModelClient } from '../src/model/codex-client.js';
import { Notebook } from '../src/storage/notebook.js';
import type { AgentTools, TranscriptRole } from '../src/types.js';
import { cleanupDir, createTempDir, createUnsignedJwt } from '../test-support/helpers.js';

test('CodexModelClient performs tool round-trips and persists previous_response_id', async (t) => {
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
        return new Response(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_1',
              output: [
                {
                  type: 'function_call',
                  call_id: 'call_1',
                  name: 'read',
                  arguments: JSON.stringify({ path: 'README.md' })
                }
              ]
            }
          })}\n\n`,
          {
            headers: { 'content-type': 'text/event-stream' }
          }
        );
      }

      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_2',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'Done reading the file.' }]
              }
            ]
          }
        })}\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' }
        }
      );
    }
  });

  const emitted: Array<{ role: TranscriptRole; text: string }> = [];
  const streamed: string[] = [];
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
    setReasoningEffort: async () => ''
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
    }
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(requests[0]?.headers.get('originator'), 'codex_cli_rs');
  assert.equal(requests[0]?.headers.get('chatgpt-account-id'), 'acct_123');
  assert.equal(requests[0]?.headers.get('session_id'), 'session-test');
  assert.equal(requests[0]?.body.model, 'gpt-5.4');
  assert.equal(requests[0]?.body.stream, true);
  assert.deepEqual(requests[0]?.body.reasoning, { effort: 'medium' });
  assert.equal('previous_response_id' in (requests[1]?.body ?? {}), false);
  assert.deepEqual(requests[1]?.body.input, [
    { role: 'user', content: 'Read the readme' },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'read',
      arguments: '{"path":"README.md"}'
    },
    { type: 'function_call_output', call_id: 'call_1', output: 'read README.md' }
  ]);

  assert.equal(notebook.getModelSession('session-test')?.previousResponseId, 'resp_2');
  assert.deepEqual(streamed, []);
  assert.equal(emitted[0]?.role, 'tool');
  assert.match(emitted[0]?.text ?? '', /\[read\]/);
  assert.equal(emitted[1]?.role, 'assistant');
  assert.equal(emitted[1]?.text, 'Done reading the file.');
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
      new Response(
        `data: ${JSON.stringify({
          type: 'response.output_text.delta',
          delta: 'Hello'
        })}\n\n` +
          `data: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: ' world'
          })}\n\n` +
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_1',
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: 'Hello world' }]
                }
              ]
            }
          })}\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' }
        }
      )
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
    setReasoningEffort: async () => ''
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
      new Response(
        `data: ${JSON.stringify({
          type: 'response.content_part.added',
          part: { type: 'output_text', text: 'Draft text' }
        })}\n\n` +
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_1',
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: 'Draft text' }]
                }
              ]
            }
          })}\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' }
        }
      )
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
    setReasoningEffort: async () => ''
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

test('CodexModelClient does not duplicate live assistant text when delta and snapshot events overlap', async (t) => {
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
      new Response(
        `data: ${JSON.stringify({
          type: 'response.output_text.delta',
          delta: 'Hello'
        })}\n\n` +
          `data: ${JSON.stringify({
            type: 'response.content_part.added',
            part: { type: 'output_text', text: 'Hello' }
          })}\n\n` +
          `data: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: ' world'
          })}\n\n` +
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              type: 'message',
              content: [{ type: 'output_text', text: 'Hello world' }]
            }
          })}\n\n` +
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_1',
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: 'Hello world' }]
                }
              ]
            }
          })}\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' }
        }
      )
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
    setReasoningEffort: async () => ''
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

  assert.deepEqual(streamed, ['Hello', 'Hello', 'Hello world', 'Hello world']);
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
      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'done' }]
              }
            ]
          }
        })}\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' }
        }
      );
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
    setReasoningEffort: async () => ''
  };

  await client.runTurn('session-test', 'ignored because history exists', tools, async () => undefined);

  assert.equal(requests.length, 1);
  assert.equal(typeof requests[0]?.instructions, 'string');
  assert.deepEqual(requests[0]?.input, [
    { role: 'system', content: 'Harness checkpoint block' },
    { role: 'user', content: 'recent user' }
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
        return new Response(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_1',
              output: [
                {
                  type: 'function_call',
                  call_id: 'call_1',
                  name: 'spawn_experiment',
                  arguments: JSON.stringify({
                    hypothesis: 'test concurrency guard',
                    budgetTokens: 1200
                  })
                }
              ]
            }
          })}\n\n`,
          {
            headers: { 'content-type': 'text/event-stream' }
          }
        );
      }

      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_2',
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'The experiment spawn failed because the harness concurrency limit was reached.'
                  }
                ]
              }
            ]
          }
        })}\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' }
        }
      );
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
    setReasoningEffort: async () => ''
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
    { role: 'user', content: 'Try spawning an experiment' },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'spawn_experiment',
      arguments: '{"hypothesis":"test concurrency guard","budgetTokens":1200}'
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
