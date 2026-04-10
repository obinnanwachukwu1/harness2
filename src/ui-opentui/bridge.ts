#!/usr/bin/env node
import readline from 'node:readline';
import { once } from 'node:events';

import { HeadlessEngine } from '../engine/headless-engine.js';
import { formatUnknownError } from '../lib/utils.js';
import { captureHeapSnapshot, writeDiagnosticReport } from './heap-snapshot.js';
import type { OpenTuiBridgeCommand, OpenTuiBridgeEvent } from './protocol.js';
import { buildOpenTuiState, diffOpenTuiState } from './render-state.js';
import type { AgentMode } from '../types.js';
import type { OpenTuiState } from './render-types.js';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const engine = await HeadlessEngine.open({
    cwd: options.cwd,
    sessionId: options.sessionId,
    agentMode: options.mode
  });

  let closed = false;
  let stateFlushScheduled = false;
  let stateFlushInFlight = false;
  let stateDirty = false;
  let lastSentState: OpenTuiState | null = null;
  const send = (event: OpenTuiBridgeEvent): void => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  const scheduleStateFlush = (): void => {
    if (closed || stateFlushScheduled || stateFlushInFlight) {
      return;
    }

    stateFlushScheduled = true;
    queueMicrotask(() => {
      stateFlushScheduled = false;
      void flushState();
    });
  };
  const flushState = async (): Promise<void> => {
    if (closed || stateFlushInFlight || !stateDirty) {
      return;
    }

    stateFlushInFlight = true;
    try {
      while (stateDirty && !closed) {
        stateDirty = false;
        const nextState = buildOpenTuiState(engine.snapshot);
        const event: OpenTuiBridgeEvent | null =
          lastSentState === null
            ? {
                type: 'hydrate',
                state: nextState
              }
            : (() => {
                const patch = diffOpenTuiState(lastSentState, nextState);
                if (!patch) {
                  return null;
                }
                return {
                  type: 'statePatch',
                  patch
                } satisfies OpenTuiBridgeEvent;
              })();
        lastSentState = nextState;
        if (!event) {
          continue;
        }
        const payload = JSON.stringify(event);
        const writable = process.stdout.write(`${payload}\n`);
        if (!writable) {
          await once(process.stdout, 'drain');
        }
      }
    } finally {
      stateFlushInFlight = false;
      if (stateDirty && !closed) {
        scheduleStateFlush();
      }
    }
  };
  const requestStateFlush = (): void => {
    stateDirty = true;
    scheduleStateFlush();
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
  const diagnosticExtra = (): Record<string, unknown> => ({
    snapshot: {
      processingTurn: engine.snapshot.processingTurn,
      transcriptEntries: engine.snapshot.transcript.length,
      liveTurnEvents: engine.snapshot.liveTurnEvents.length,
      experiments: engine.snapshot.experiments.length,
      studyDebts: engine.snapshot.studyDebts.length,
      statusText: engine.snapshot.statusText
    }
  });
  const emitDiagnosticReport = async (trigger: 'ui' | 'signal'): Promise<void> => {
    try {
      const report = await writeDiagnosticReport({
        cwd: engine.snapshot.session.cwd,
        processType: 'bridge',
        trigger,
        extra: diagnosticExtra()
      });
      send({
        type: 'diagnosticCapture',
        processType: report.processType,
        mode: report.mode,
        trigger: report.trigger,
        path: report.path,
        pid: report.pid,
        rss: report.rss,
        heapUsed: report.heapUsed
      });
    } catch (error) {
      send({
        type: 'error',
        message: `Bridge diagnostic report failed: ${formatUnknownError(error)}`
      });
    }
  };
  const emitHeapSnapshot = async (trigger: 'ui' | 'signal'): Promise<void> => {
    try {
      const snapshot = await captureHeapSnapshot({
        cwd: engine.snapshot.session.cwd,
        processType: 'bridge',
        trigger,
        extra: diagnosticExtra()
      });
      send({
        type: 'diagnosticCapture',
        processType: snapshot.processType,
        mode: snapshot.mode,
        trigger: snapshot.trigger,
        path: snapshot.path,
        metaPath: snapshot.metaPath,
        pid: snapshot.pid,
        rss: snapshot.rss,
        heapUsed: snapshot.heapUsed
      });
    } catch (error) {
      send({
        type: 'error',
        message: `Bridge heap snapshot failed: ${formatUnknownError(error)}`
      });
    }
  };

  const unsubscribe = engine.subscribe(() => {
    requestStateFlush();
  });

  send({
    type: 'ready',
    sessionId: engine.snapshot.session.id,
    cwd: engine.snapshot.session.cwd
  });
  requestStateFlush();

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });
  process.on('SIGUSR2', () => {
    void emitHeapSnapshot('signal');
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
        case 'captureDiagnostics':
          if (command.mode === 'heap') {
            await emitHeapSnapshot(command.trigger ?? 'ui');
            break;
          }
          await emitDiagnosticReport(command.trigger ?? 'ui');
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

function parseArgs(args: string[]): { cwd: string; sessionId?: string; mode?: AgentMode } {
  let cwd = process.cwd();
  let sessionId: string | undefined;
  let mode: AgentMode | undefined;

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

    if (value === '--mode') {
      const next = args[index + 1];
      if (next !== 'study' && next !== 'plan' && next !== 'direct') {
        throw new Error('Missing or invalid value for --mode');
      }
      mode = next;
      index += 1;
    }
  }

  return { cwd, sessionId, mode };
}

main().catch((error) => {
  const message = formatUnknownError(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
