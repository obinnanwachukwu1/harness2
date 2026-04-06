export type TranscriptRole = 'user' | 'assistant' | 'tool' | 'system';

export type ExperimentStatus =
  | 'running'
  | 'validated'
  | 'invalidated'
  | 'inconclusive';

export type ExperimentObservationTag =
  | 'promising'
  | 'discovery'
  | 'blocker'
  | 'question'
  | 'conclusion';

export interface SessionRecord {
  id: string;
  cwd: string;
  startedAt: string;
  lastActiveAt: string;
}

export interface TranscriptEntry {
  id: number;
  sessionId: string;
  role: TranscriptRole;
  text: string;
  createdAt: string;
}

export type ModelHistoryItem =
  | {
      type: 'message';
      role: 'user' | 'assistant' | 'system';
      content: string;
    }
  | {
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: 'function_call_output';
      call_id: string;
      output: string;
    };

export interface ExperimentRecord {
  id: string;
  sessionId: string;
  hypothesis: string;
  command: string;
  context: string;
  baseCommitSha: string;
  branchName: string;
  worktreePath: string;
  status: ExperimentStatus;
  budget: number;
  tokensUsed: number;
  contextTokensUsed: number;
  toolOutputTokensUsed: number;
  observationTokensUsed: number;
  preserve: boolean;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  finalVerdict: ExperimentStatus | null;
  finalSummary: string | null;
  discovered: string[];
  promote: boolean;
}

export interface ExperimentObservation {
  id: number;
  experimentId: string;
  message: string;
  createdAt: string;
  tags: ExperimentObservationTag[];
}

export interface ExperimentResolution {
  id: string;
  verdict: ExperimentStatus;
  summary: string;
  discovered: string[];
  promote: boolean;
  preserved: boolean;
  worktreePath: string;
  branchName: string;
  baseCommitSha: string;
  tokensUsed: number;
  contextTokensUsed: number;
  toolOutputTokensUsed: number;
  observationTokensUsed: number;
  budget: number;
  hypothesis: string;
  resolvedAt: string;
}

export interface ExperimentSearchResult {
  experimentId: string;
  hypothesis: string;
  status: ExperimentStatus;
  summary: string;
  discovered: string[];
}

export interface ExperimentWaitResult {
  timedOut: boolean;
  experimentId: string;
  hypothesis: string;
  status: ExperimentStatus;
  summary: string;
  discovered: string[];
  tokensUsed: number;
  contextTokensUsed: number;
  toolOutputTokensUsed: number;
  observationTokensUsed: number;
  budget: number;
  lastObservationAt: string | null;
  lastObservationSnippet: string | null;
}

export interface SessionCheckpointRecord {
  id: number;
  sessionId: string;
  createdAt: string;
  goal: string;
  completed: string;
  next: string;
  openRisks: string | null;
  gitLog: string;
  gitStatus: string;
  gitDiffStat: string;
  lastTestStatus: string | null;
  activeExperimentSummaries: ExperimentSearchResult[];
  checkpointBlock: string;
  tailStartHistoryId: number | null;
}

export interface OpenAICodexAuthRecord {
  provider: 'openai-codex';
  type: 'oauth';
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  expiresAt: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelSessionRecord {
  sessionId: string;
  provider: 'openai-codex';
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | null;
  previousResponseId: string | null;
  updatedAt: string;
}

export interface OpenAICodexJwtClaims {
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
    organization_id?: string;
    project_id?: string;
  };
  organization_id?: string;
  project_id?: string;
  exp?: number;
  sub?: string;
  email?: string;
}

export interface ExperimentDetails extends ExperimentRecord {
  observations: ExperimentObservation[];
}

export interface EngineSnapshot {
  session: SessionRecord;
  transcript: TranscriptEntry[];
  experiments: ExperimentRecord[];
  processingTurn: boolean;
  statusText: string;
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | null;
  estimatedContextTokens: number;
  contextWindowTokens: number;
  liveAssistantText: string | null;
}

export interface SpawnExperimentInput {
  sessionId: string;
  hypothesis: string;
  context?: string;
  budgetTokens: number;
  preserve: boolean;
}

export interface AgentTools {
  bash(command: string): Promise<string>;
  read(filePath: string): Promise<string>;
  write(filePath: string, content: string): Promise<string>;
  edit(filePath: string, findText: string, replaceText: string): Promise<string>;
  glob(pattern: string): Promise<string[]>;
  grep(pattern: string, target?: string): Promise<string>;
  spawnExperiment(input: Omit<SpawnExperimentInput, 'sessionId'>): Promise<ExperimentRecord>;
  readExperiment(experimentId: string): Promise<ExperimentDetails>;
  waitExperiment?(experimentId: string, timeoutMs?: number): Promise<{
    timedOut: boolean;
    experimentId: string;
    hypothesis: string;
    status: ExperimentStatus;
    summary: string;
    discovered: string[];
    tokensUsed: number;
    contextTokensUsed: number;
    toolOutputTokensUsed: number;
    observationTokensUsed: number;
    budget: number;
    lastObservationAt: string | null;
    lastObservationSnippet: string | null;
  }>;
  searchExperiments?(query?: string): Promise<ExperimentSearchResult[]>;
  compact?(
    goal: string,
    completed: string,
    next: string,
    openRisks?: string
  ): Promise<{ ok: true; checkpointId: number }>;
  logObservation?(
    experimentId: string,
    message: string,
    tags?: ExperimentObservationTag[]
  ): Promise<ExperimentDetails>;
  resolveExperiment?(input: {
    experimentId: string;
    verdict: ExperimentStatus;
    summary: string;
    discovered: string[];
    promote: boolean;
  }): Promise<ExperimentResolution>;
  authLogin(): Promise<string>;
  authStatus(): Promise<string>;
  authLogout(): Promise<string>;
  getModelSettings(): Promise<string>;
  setModel(model: string): Promise<string>;
  setReasoningEffort(effort: 'low' | 'medium' | 'high' | 'off'): Promise<string>;
}

export interface AgentRunContext {
  tools: AgentTools;
  emit(role: TranscriptRole, text: string): Promise<void>;
  runModel(input: string): Promise<void>;
}

export interface AgentRunner {
  runTurn(input: string, context: AgentRunContext): Promise<void>;
}

export interface DoctorCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  cwd: string;
  healthy: boolean;
  checks: DoctorCheck[];
}
