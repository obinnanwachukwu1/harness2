export type OpenTuiRenderBlock =
  | {
      id: string;
      kind: 'user';
      text: string;
    }
  | {
      id: string;
      kind: 'assistant';
      text: string;
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
    };

export interface OpenTuiExperimentSummary {
  id: string;
  status: string;
  summary: string;
  meta: string;
}

export interface OpenTuiState {
  sessionId: string;
  cwd: string;
  statusLine: string;
  thinkingEnabled: boolean;
  inputPlaceholder: string;
  blocks: OpenTuiRenderBlock[];
  experiments: OpenTuiExperimentSummary[];
}
