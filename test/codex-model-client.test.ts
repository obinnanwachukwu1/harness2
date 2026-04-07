import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { OpenAICodexAuth } from '../src/auth/openai-codex.js';
import { CodexModelClient, EXPERIMENT_TOOL_DEFINITIONS } from '../src/model/codex-client.js';
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
  assert.equal(requests[1]?.body.previous_response_id, 'resp_1');
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
  assert.match(emitted[0]?.text ?? '', /^@@tool\tread\tRead\(README\.md\)/);
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

test('CodexModelClient injects an early study-opportunity hint before mutation', async (t) => {
  const tempDir = await createTempDir('h2-model-early-study-hint-');
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
        return new Response(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_1',
              output: Array.from({ length: 5 }, (_, index) => ({
                type: 'function_call',
                call_id: `call_${index + 1}`,
                name: index % 2 === 0 ? 'read' : 'grep',
                arguments:
                  index % 2 === 0
                    ? JSON.stringify({ path: `app/auth/file-${index + 1}.ts` })
                    : JSON.stringify({ pattern: 'session', target: 'app/auth' })
              }))
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
                content: [{ type: 'output_text', text: 'Done.' }]
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
    'Investigate whether an isolated side task can install a dependency safely.',
    tools,
    async () => {},
    async () => {}
  );

  assert.equal(requests.length, 2);
  const secondInput = requests[1]?.input as Array<Record<string, unknown>>;
  assert.equal(secondInput[0]?.role, 'developer');
  assert.match(String(secondInput[0]?.content ?? ''), /launch one bounded study now/i);
});

test('CodexModelClient injects a post-spawn wait hint after repeated probing', async (t) => {
  const tempDir = await createTempDir('h2-model-post-spawn-hint-');
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
        return new Response(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_1',
              output: [
                {
                  type: 'function_call',
                  call_id: 'call_spawn',
                  name: 'spawn_experiment',
                  arguments: JSON.stringify({ hypothesis: 'test it' })
                }
              ]
            }
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        );
      }

      if (responseCount === 2) {
        return new Response(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_2',
              output: [
                {
                  type: 'function_call',
                  call_id: 'call_read_1',
                  name: 'read',
                  arguments: JSON.stringify({ path: 'a.ts' })
                },
                {
                  type: 'function_call',
                  call_id: 'call_read_2',
                  name: 'grep',
                  arguments: JSON.stringify({ pattern: 'foo' })
                },
                {
                  type: 'function_call',
                  call_id: 'call_read_3',
                  name: 'bash',
                  arguments: JSON.stringify({ command: 'pwd' })
                }
              ]
            }
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        );
      }

      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_3',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'Done.' }]
              }
            ]
          }
        })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      );
    }
  });

  const tools: AgentTools = {
    bash: async () => 'pwd',
    read: async () => 'read result',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => 'grep result',
    spawnExperiment: async () =>
      JSON.stringify({
        id: 'exp-123',
        status: 'running'
      }),
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
    'Investigate whether multiple side tasks can run safely.',
    tools,
    async () => {},
    async () => {}
  );

  assert.equal(requests.length, 3);
  const thirdInput = requests[2]?.input as Array<Record<string, unknown>>;
  assert.equal(thirdInput[0]?.role, 'developer');
  assert.match(String(thirdInput[0]?.content ?? ''), /You already have a live experiment/);
});

test('CodexModelClient injects a pre-edit guard hint after long investigation without an experiment', async (t) => {
  const tempDir = await createTempDir('h2-model-pre-edit-hint-');
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
        return new Response(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_1',
              output: Array.from({ length: 8 }, (_, index) => ({
                type: 'function_call',
                call_id: `call_probe_${index + 1}`,
                name: index % 2 === 0 ? 'read' : 'grep',
                arguments:
                  index % 2 === 0
                    ? JSON.stringify({ path: `file-${index + 1}.ts` })
                    : JSON.stringify({ pattern: 'resume', target: 'src' })
              }))
            }
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        );
      }

      if (responseCount === 2) {
        return new Response(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_2',
              output: [
                {
                  type: 'function_call',
                  call_id: 'call_edit',
                  name: 'edit',
                  arguments: JSON.stringify({
                    path: 'src/example.ts',
                    findText: 'old',
                    replaceText: 'new'
                  })
                }
              ]
            }
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        );
      }

      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_3',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'Done.' }]
              }
            ]
          }
        })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      );
    }
  });

  const tools: AgentTools = {
    bash: async () => '',
    read: async () => 'read result',
    write: async () => '',
    edit: async () => '',
    glob: async () => [],
    grep: async () => 'grep result',
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
    'Implement automatic resume after interruptions with the fastest path that works.',
    tools,
    async () => {},
    async () => {}
  );

  assert.equal(requests.length, 3);
  const thirdInput = requests[2]?.input as Array<Record<string, unknown>>;
  assert.equal(thirdInput[0]?.role, 'developer');
  assert.match(String(thirdInput[0]?.content ?? ''), /moving toward implementation/i);
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
        return new Response(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_1',
              output: [
                {
                  type: 'function_call',
                  call_id: 'call_read_1',
                  name: 'read',
                  arguments: JSON.stringify({ path: 'a.ts' })
                },
                {
                  type: 'function_call',
                  call_id: 'call_grep_1',
                  name: 'grep',
                  arguments: JSON.stringify({ pattern: 'foo' })
                }
              ]
            }
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        );
      }

      if (responseCount === 2) {
        return new Response(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_2',
              output: [
                {
                  type: 'function_call',
                  call_id: 'call_bash_1',
                  name: 'bash',
                  arguments: JSON.stringify({ command: 'pwd' })
                },
                {
                  type: 'function_call',
                  call_id: 'call_glob_1',
                  name: 'glob',
                  arguments: JSON.stringify({ pattern: '*.ts' })
                }
              ]
            }
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        );
      }

      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_3',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'Done.' }]
              }
            ]
          }
        })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      );
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
  assert.match(String(thirdInput[0]?.content ?? ''), /without logging a fresh observation/);
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
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await client.runTurn('session-test', 'ignored because history exists', tools, async () => undefined);

  assert.equal(requests.length, 1);
  assert.equal(typeof requests[0]?.instructions, 'string');
  assert.deepEqual(requests[0]?.input, [
    { role: 'developer', content: 'Harness checkpoint block' },
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

test('CodexModelClient injects open study debt reminders into model requests', async (t) => {
  const tempDir = await createTempDir('h2-model-study-debt-');
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
      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ack' }]
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
    setReasoningEffort: async () => '',
    getThinkingMode: async () => '',
    setThinkingMode: async () => ''
  };

  await client.runTurn('session-test', 'ignored because history exists', tools, async () => undefined);

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.input, [
    {
      role: 'developer',
      content: notebook.buildOpenStudyDebtReminder('session-test')
    },
    { role: 'user', content: 'implement auth continuity' }
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

      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'Recovered after retry.' }]
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
      new Response(
        [
          `data: ${JSON.stringify({ type: 'response.text.delta', delta: 'Hello' })}`,
          '',
          '',
          `data: ${JSON.stringify({ type: 'response.text.delta', delta: ' world' })}`,
          '',
          '',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_text_only',
              output: [
                {
                  type: 'message',
                  content: [{ type: 'text', text: { value: 'Hello world' } }]
                }
              ]
            }
          })}`,
          '',
          ''
        ].join('\n'),
        {
          headers: { 'content-type': 'text/event-stream' }
        }
      )
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
        return new Response(
          `data: ${JSON.stringify({
            type: 'response.output_item.added',
            item: {
              id: 'fc_1',
              type: 'function_call',
              call_id: 'call_1',
              name: 'read',
              arguments: '',
              status: 'in_progress'
            }
          })}\n\n` +
            `data: ${JSON.stringify({
              type: 'response.function_call_arguments.done',
              item_id: 'fc_1',
              output_index: 0,
              arguments: '{"path":"README.md"}'
            })}\n\n` +
            `data: ${JSON.stringify({
              type: 'response.output_item.done',
              item: {
                id: 'fc_1',
                type: 'function_call',
                call_id: 'call_1',
                name: 'read',
                arguments: '{"path":"README.md"}',
                status: 'completed'
              }
            })}\n\n` +
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_1',
                output: []
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
                content: [{ type: 'output_text', text: 'Done.' }]
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
                  arguments: JSON.stringify({ path: 'README.md', startLine: 10, endLine: 20 })
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
                content: [{ type: 'output_text', text: 'Done.' }]
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
