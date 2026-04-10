import type { OpenTuiState, OpenTuiStatePatch } from './render-types.js';

export type OpenTuiBridgeCommand =
  | {
      type: 'submit';
      text: string;
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

export type OpenTuiBridgeEvent =
  | {
      type: 'ready';
      sessionId: string;
      cwd: string;
    }
  | {
      type: 'hydrate';
      state: OpenTuiState;
    }
  | {
      type: 'statePatch';
      patch: OpenTuiStatePatch;
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
