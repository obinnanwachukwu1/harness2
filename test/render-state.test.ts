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
          toolName: 'bash',
          label: 'Bash(pwd)',
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
