import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import path from 'node:path';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

import type { BridgeCommand, BridgeEvent } from '../../../src/ui/protocol.js';

interface BridgeClientEvents {
  event: [BridgeEvent];
  exit: [number | null];
}

const IGNORED_STDERR_PATTERNS = [
  /ExperimentalWarning:.*SQLite/i,
  /ExperimentalWarning:.*node:sqlite/i
];

export class BridgeClient extends EventEmitter<BridgeClientEvents> {
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private rl: readline.Interface | null = null;

  constructor(
    private readonly options: {
      cwd: string;
      sessionId?: string;
      mode?: 'study' | 'plan' | 'direct';
    }
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    const repoRoot = path.resolve(import.meta.dir, '../../..');
    const bridgePath = path.join(repoRoot, 'src/ui/bridge.ts');
    const args = ['--import', 'tsx', bridgePath, '--cwd', this.options.cwd];
    if (this.options.sessionId) {
      args.push('--session', this.options.sessionId);
    }
    if (this.options.mode) {
      args.push('--mode', this.options.mode);
    }

    const child = spawn('node', args, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;

    this.rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    });

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      try {
        this.emit('event', JSON.parse(trimmed) as BridgeEvent);
      } catch {
        this.emit('event', {
          type: 'error',
          message: `Invalid bridge event: ${trimmed}`
        });
      }
    });

    child.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (!message) {
        return;
      }
      if (shouldIgnoreBridgeStderr(message)) {
        return;
      }

      this.emit('event', {
        type: 'error',
        message
      });
    });

    child.on('exit', (code) => {
      this.emit('exit', code);
    });
  }

  send(command: BridgeCommand): void {
    if (!this.child) {
      throw new Error('Bridge is not running.');
    }

    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async dispose(): Promise<void> {
    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = null;
    this.rl?.close();
    this.rl = null;

    const shutdown: BridgeCommand = { type: 'shutdown' };
    child.stdin.write(`${JSON.stringify(shutdown)}\n`);
    child.stdin.end();

    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGTERM');
        }
      }, 200);
    });
  }
}

function shouldIgnoreBridgeStderr(message: string): boolean {
  return IGNORED_STDERR_PATTERNS.some((pattern) => pattern.test(message));
}
