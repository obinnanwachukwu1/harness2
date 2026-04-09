import assert from 'node:assert/strict';
import test from 'node:test';

import { formatLiveToolBody, formatToolHeader } from '../src/model/codex-tooling.js';

test('formatToolHeader falls back instead of throwing on malformed tool arguments', () => {
  assert.doesNotThrow(() =>
    formatToolHeader('rg', JSON.stringify({ target: '.' }))
  );
  assert.equal(formatToolHeader('rg', JSON.stringify({ target: '.' })), 'rg');
});

test('formatLiveToolBody falls back to a raw argument preview on malformed tool arguments', () => {
  const lines = formatLiveToolBody('rg', JSON.stringify({ target: '.' }));
  assert.deepEqual(lines, ['{', '  "target": "."', '}']);
});
