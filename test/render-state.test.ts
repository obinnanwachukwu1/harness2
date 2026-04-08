import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOpenTuiState } from '../src/ui-opentui/render-state.js';
import type { EngineSnapshot } from '../src/types.js';

function createSnapshot(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return {
    session: {
      id: 'session-test',
      cwd: '/tmp/repo',
      startedAt: '2026-04-07T00:00:00.000Z',
      lastActiveAt: '2026-04-07T00:00:00.000Z'
    },
    transcript: [],
    experiments: [],
    studyDebts: [],
    processingTurn: false,
    currentTurnStartedAt: null,
    statusText: 'idle',
    model: 'gpt-5.4',
    reasoningEffort: 'medium',
    estimatedContextTokens: 0,
    contextWindowTokens: 0,
    standardRateContextTokens: null,
    liveTurnEvents: [],
    thinkingEnabled: true,
    ...overrides
  };
}

test('buildOpenTuiState keeps current-turn completed tools in the live tail order', () => {
  const startedAt = '2026-04-07T00:00:02.000Z';
  const state = buildOpenTuiState(
    createSnapshot({
      processingTurn: true,
      currentTurnStartedAt: startedAt,
      transcript: [
        {
          id: 1,
          sessionId: 'session-test',
          role: 'assistant',
          text: 'Earlier transcript',
          createdAt: '2026-04-07T00:00:01.000Z'
        },
        {
          id: 2,
          sessionId: 'session-test',
          role: 'tool',
          text: '@@tool\tweb_search\tWebSearch(weather)\nquery: weather',
          createdAt: '2026-04-07T00:00:03.000Z'
        }
      ],
      liveTurnEvents: [
        {
          id: 'live-thinking-1',
          kind: 'thinking',
          text: 'Thinking after the search',
          live: true
        },
        {
          id: 'live-tool-1',
          kind: 'tool',
          transcriptText: '@@tool\tweb_search\tWebSearch(weather)\nquery: weather',
          live: false,
          callId: 'call-1',
          toolName: null,
          label: null,
          detail: null,
          body: [],
          providerExecuted: true
        }
      ]
    })
  );

  assert.deepEqual(
    state.blocks.map((block) => `${block.kind}:${block.id}`),
    ['assistant:assistant-1', 'thinking:live-thinking-1', 'tool:live-tool-1']
  );
});

test('buildOpenTuiState includes live tool argument previews', () => {
  const state = buildOpenTuiState(
    createSnapshot({
      liveTurnEvents: [
        {
          id: 'live-tool-1',
          kind: 'tool',
          transcriptText: null,
          live: true,
          callId: 'call-1',
          toolName: 'exec_command',
          label: 'Exec(pwd)',
          detail: 'running…',
          body: ['command: pwd'],
          providerExecuted: false
        }
      ]
    })
  );

  const toolBlock = state.blocks[0];
  assert.ok(toolBlock && toolBlock.kind === 'tool');
  assert.deepEqual(toolBlock.body, ['running…', 'command: pwd']);
  assert.equal(toolBlock.live, true);
});

test('buildOpenTuiState summarizes exec output rows', () => {
  const state = buildOpenTuiState(
    createSnapshot({
      transcript: [
        {
          id: 1,
          sessionId: 'session-test',
          role: 'tool',
          text: '@@tool\texec_command\tExec(pwd)\n{\n  "processId": 4,\n  "exitCode": null,\n  "stdout": "ready\\n",\n  "stderr": "",\n  "running": true,\n  "command": "npm run dev",\n  "cwd": "."\n}',
          createdAt: '2026-04-07T00:00:03.000Z'
        }
      ]
    })
  );

  const toolBlock = state.blocks[0];
  assert.ok(toolBlock && toolBlock.kind === 'tool');
  assert.equal(toolBlock.header, 'Exec(pwd)');
  assert.deepEqual(toolBlock.body, ['process  4', 'status  running', 'ready']);
});

test('buildOpenTuiState shows question ids in headers and summaries in the body', () => {
  const state = buildOpenTuiState(
    createSnapshot({
      transcript: [
        {
          id: 1,
          sessionId: 'session-test',
          role: 'tool',
          text: '@@tool\tresolve_question\tresolve question(question-abc)\n{\n  "questionId": "question-abc",\n  "status": "closed",\n  "summary": "what streaming shape does the configured backend emit",\n  "resolution": "study_run",\n  "note": "Provider emits SSE but needs tolerant parsing."\n}',
          createdAt: '2026-04-07T00:00:03.000Z'
        }
      ]
    })
  );

  const toolBlock = state.blocks[0];
  assert.ok(toolBlock && toolBlock.kind === 'tool');
  assert.equal(toolBlock.header, 'resolve question(question-abc)');
  assert.deepEqual(toolBlock.body, [
    'note  what streaming shape does the configured backend emit',
    'status  closed',
    'resolution  study_run',
    'note  Provider emits SSE but needs tolerant parsing.'
  ]);
});

test('buildOpenTuiState renders experiment notices as experiment tool rows', () => {
  const state = buildOpenTuiState(
    createSnapshot({
      processingTurn: true,
      currentTurnStartedAt: '2026-04-07T00:00:03.000Z',
      liveTurnEvents: [
        {
          id: 'live-tool-1',
          kind: 'tool',
          transcriptText:
            '@@tool\texperiment_notice\tExperiment resolved\n{\n  "experimentId": "exp-123",\n  "status": "validated",\n  "summary": "Provider streams SSE content deltas.",\n  "hypothesis": "backend supports OpenAI-style streaming",\n  "next": "removed"\n}',
          live: false,
          callId: null,
          toolName: null,
          label: null,
          detail: null,
          body: [],
          providerExecuted: false
        }
      ]
    })
  );

  const toolBlock = state.blocks[0];
  assert.ok(toolBlock && toolBlock.kind === 'tool');
  assert.equal(toolBlock.tone, 'experiment');
  assert.equal(toolBlock.header, 'Experiment resolved');
  assert.deepEqual(toolBlock.body, [
    'exp-123',
    'status  validated',
    'Provider streams SSE content deltas.',
    'backend supports OpenAI-style streaming'
  ]);
});
