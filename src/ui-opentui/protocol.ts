import type { OpenTuiState } from './render-types.js';

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
      type: 'shutdown';
    };

export type OpenTuiBridgeEvent =
  | {
      type: 'ready';
      sessionId: string;
      cwd: string;
    }
  | {
      type: 'state';
      state: OpenTuiState;
    }
  | {
      type: 'error';
      message: string;
    };
