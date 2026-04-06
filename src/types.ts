export type TranscriptRole = 'user' | 'assistant' | 'tool' | 'system';

export type ExperimentStatus =
  | 'running'
  | 'validated'
  | 'invalidated'
  | 'inconclusive';

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
  preserve: boolean;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  finalVerdict: ExperimentStatus | null;
  finalSummary: string | null;
}

export interface ExperimentObservation {
  id: number;
  experimentId: string;
  message: string;
  createdAt: string;
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
}

export interface SpawnExperimentInput {
  sessionId: string;
  hypothesis: string;
  command: string;
  context?: string;
  budget: number;
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
}

export interface AgentRunContext {
  tools: AgentTools;
  emit(role: TranscriptRole, text: string): Promise<void>;
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
