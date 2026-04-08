#!/usr/bin/env node
import readline from 'node:readline';

import { HeadlessEngine } from '../engine/headless-engine.js';
import { formatUnknownError } from '../lib/utils.js';
import type { OpenTuiBridgeCommand, OpenTuiBridgeEvent } from './protocol.js';
import { buildOpenTuiState } from './render-state.js';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const engine = await HeadlessEngine.open({
    cwd: options.cwd,
    sessionId: options.sessionId
  });

  let closed = false;
  const send = (event: OpenTuiBridgeEvent): void => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };

  const cleanup = async (): Promise<void> => {
    if (closed) {
      return;
    }

    closed = true;
    unsubscribe();
    rl.close();
    await engine.dispose();
  };

  const unsubscribe = engine.subscribe(() => {
    send({
      type: 'state',
      state: buildOpenTuiState(engine.snapshot)
    });
  });

  send({
    type: 'ready',
    sessionId: engine.snapshot.session.id,
    cwd: engine.snapshot.session.cwd
  });
  send({
    type: 'state',
    state: buildOpenTuiState(engine.snapshot)
  });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let command: OpenTuiBridgeCommand;
    try {
      command = JSON.parse(trimmed) as OpenTuiBridgeCommand;
    } catch {
      send({
        type: 'error',
        message: 'Invalid bridge command JSON.'
      });
      continue;
    }

    try {
      switch (command.type) {
        case 'submit':
          if (!command.text.trim()) {
            break;
          }
          void engine.submit(command.text).catch((error) => {
            send({
              type: 'error',
              message: formatUnknownError(error)
            });
          });
          break;
        case 'setThinking':
          engine.setThinkingEnabled(command.enabled);
          break;
        case 'shutdown':
          await cleanup();
          process.exit(0);
          break;
        default:
          send({
            type: 'error',
            message: `Unknown bridge command: ${(command as { type?: string }).type ?? '(missing type)'}`
          });
      }
    } catch (error) {
      send({
        type: 'error',
        message: formatUnknownError(error)
      });
    }
  }

  await cleanup();
}

function parseArgs(args: string[]): { cwd: string; sessionId?: string } {
  let cwd = process.cwd();
  let sessionId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--cwd') {
      const next = args[index + 1];
      if (!next) {
        throw new Error('Missing value for --cwd');
      }
      cwd = next;
      index += 1;
      continue;
    }

    if (value === '--session') {
      const next = args[index + 1];
      if (!next) {
        throw new Error('Missing value for --session');
      }
      sessionId = next;
      index += 1;
      continue;
    }
  }

  return { cwd, sessionId };
}

main().catch((error) => {
  const message = formatUnknownError(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
