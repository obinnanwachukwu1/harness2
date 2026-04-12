import assert from 'node:assert/strict';
import test from 'node:test';

import { buildState, diffState } from '../src/ui/render-state.js';
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
    effectiveContextBudgetTokens: 0,
    fullContextWindowTokens: 0,
    inputLimitContextTokens: null,
    standardRateContextTokens: null,
    allowOverStandardContext: false,
    liveTurnEvents: [],
    thinkingEnabled: true,
    activePlan: null,
    pendingUserRequest: null,
    todos: [],
    agentMode: 'study',
    planModePhase: null,
    ...overrides
  };
}

test('buildState keeps current-turn completed tools in the live tail order', () => {
  const startedAt = '2026-04-07T00:00:02.000Z';
  const state = buildState(
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

test('buildState includes live tool argument previews', () => {
  const state = buildState(
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

test('buildState summarizes exec output rows', () => {
  const state = buildState(
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

test('buildState shows question ids in headers and summaries in the body', () => {
  const state = buildState(
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

test('buildState renders experiment notices as experiment tool rows', () => {
  const state = buildState(
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

test('buildState surfaces a pending single-choice ask_user request', () => {
  const state = buildState(
    createSnapshot({
      agentMode: 'plan',
      planModePhase: 'planning',
      pendingUserRequest: {
        sessionId: 'session-test',
        kind: 'clarification',
        responseKind: 'single_choice',
        question: 'Which rollout should we use?',
        context: 'We need a safe migration path.',
        options: [
          { id: 'a', label: 'Immediate', description: 'Turn it on everywhere now.' },
          { id: 'b', label: 'Gradual', description: 'Roll it out in stages.' }
        ],
        recommendedOptionId: 'b',
        recommendedResponse: null,
        reason: 'Gradual rollout is safer.',
        createdAt: '2026-04-07T00:00:00.000Z',
        updatedAt: '2026-04-07T00:00:00.000Z'
      }
    })
  );

  assert.equal(state.inputPlaceholder, 'Reply to the pending question…');
  assert.equal(state.status.label, 'waiting');
  assert.equal(state.status.pendingText, 'pick b');
  const toolBlock = state.blocks.at(-1);
  assert.ok(toolBlock && toolBlock.kind === 'tool');
  assert.equal(toolBlock.header, 'ask_user  clarification  single_choice');
  assert.match(toolBlock.body.join('\n'), /b \[recommended\]/);
});

test('buildState uses the actual context window for status text and percent', () => {
  const state = buildState(
    createSnapshot({
      model: 'gpt-5.4',
      estimatedContextTokens: 50_000,
      effectiveContextBudgetTokens: 75_000,
      fullContextWindowTokens: 1_050_000,
      standardRateContextTokens: 200_000
    })
  );

  assert.equal(state.status.contextText, '50k/75k');
  assert.equal(state.status.contextUsagePercent, 67);
  assert.equal(state.status.usageText, '67% used');
});

test('diffState omits unchanged blocks and only upserts the changed live block', () => {
  const previous = buildState(
    createSnapshot({
      transcript: [
        {
          id: 1,
          sessionId: 'session-test',
          role: 'user',
          text: 'hello',
          createdAt: '2026-04-07T00:00:01.000Z'
        }
      ],
      liveTurnEvents: [
        {
          id: 'live-assistant-1',
          kind: 'assistant',
          text: 'draft',
          live: true
        }
      ]
    })
  );
  const next = buildState(
    createSnapshot({
      transcript: [
        {
          id: 1,
          sessionId: 'session-test',
          role: 'user',
          text: 'hello',
          createdAt: '2026-04-07T00:00:01.000Z'
        }
      ],
      liveTurnEvents: [
        {
          id: 'live-assistant-1',
          kind: 'assistant',
          text: 'draft with more text',
          live: true
        }
      ]
    })
  );

  const patch = diffState(previous, next);

  assert.ok(patch);
  assert.equal(patch.removeBlockIds, undefined);
  assert.equal(patch.blockOrder, undefined);
  assert.deepEqual(patch.upsertBlocks?.map((block) => block.id), ['live-assistant-1']);
});

test('diffState emits block order when the transcript shape changes', () => {
  const previous = buildState(
    createSnapshot({
      transcript: [
        {
          id: 1,
          sessionId: 'session-test',
          role: 'assistant',
          text: 'first',
          createdAt: '2026-04-07T00:00:01.000Z'
        }
      ]
    })
  );
  const next = buildState(
    createSnapshot({
      transcript: [
        {
          id: 2,
          sessionId: 'session-test',
          role: 'user',
          text: 'new first',
          createdAt: '2026-04-07T00:00:00.000Z'
        },
        {
          id: 1,
          sessionId: 'session-test',
          role: 'assistant',
          text: 'first',
          createdAt: '2026-04-07T00:00:01.000Z'
        }
      ]
    })
  );

  const patch = diffState(previous, next);

  assert.ok(patch);
  assert.deepEqual(patch.blockOrder, ['user-2', 'assistant-1']);
  assert.deepEqual(
    patch.upsertBlocks?.map((block) => block.id).sort(),
    ['assistant-1', 'user-2']
  );
});
