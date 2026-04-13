export type RenderBlock =
  | {
      id: string;
      kind: 'user';
      text: string;
    }
  | {
      id: string;
      kind: 'assistant';
      text: string;
      tone?: 'default' | 'interruption';
      live?: boolean;
    }
  | {
      id: string;
      kind: 'thinking';
      text: string;
      live?: boolean;
    }
  | {
      id: string;
      kind: 'tool';
      tone: 'tool' | 'experiment' | 'study_debt';
      header: string;
      body: string[];
      footer: string[];
      live?: boolean;
    }
  | {
      id: string;
      kind: 'diff';
      title: string;
      diff: string;
      filetype?: string;
      view?: 'unified' | 'split';
      live?: boolean;
    };

export interface ExperimentSummary {
  id: string;
  status: string;
  summary: string;
  meta: string;
}

export interface State {
  sessionId: string;
  cwd: string;
  processingTurn: boolean;
  queuedUserMessages: string[];
  status: {
    label: string;
    modeText: string;
    model: string;
    contextText: string;
    contextUsagePercent: number;
    usageText: string;
    pendingText: string | null;
  };
  thinkingEnabled: boolean;
  inputPlaceholder: string;
  blocks: RenderBlock[];
  experiments: ExperimentSummary[];
}

export interface StatePatch {
  sessionId: string;
  cwd: string;
  processingTurn?: boolean;
  queuedUserMessages?: string[];
  status?: State['status'];
  thinkingEnabled?: boolean;
  inputPlaceholder?: string;
  upsertBlocks?: RenderBlock[];
  removeBlockIds?: string[];
  blockOrder?: string[];
  experiments?: ExperimentSummary[];
}
