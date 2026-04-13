import type { State, StatePatch } from './render-types.js';

export type BridgeCommand =
  | {
      type: 'submit';
      text: string;
    }
  | {
      type: 'interrupt';
    }
  | {
      type: 'setThinking';
      enabled: boolean;
    }
  | {
      type: 'captureDiagnostics';
      mode: 'report' | 'heap';
      trigger?: 'ui' | 'signal';
    }
  | {
      type: 'shutdown';
    };

export type BridgeEvent =
  | {
      type: 'ready';
      sessionId: string;
      cwd: string;
    }
  | {
      type: 'hydrate';
      state: State;
    }
  | {
      type: 'statePatch';
      patch: StatePatch;
    }
  | {
      type: 'error';
      message: string;
    }
  | {
      type: 'diagnosticCapture';
      processType: 'tui' | 'bridge';
      mode: 'report' | 'heap';
      trigger: 'ui' | 'signal';
      path: string;
      metaPath?: string;
      pid: number;
      rss: number;
      heapUsed: number;
    };
