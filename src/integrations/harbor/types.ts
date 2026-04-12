import type {
  AgentMode,
  ExperimentRecord,
  ModelHistoryItem,
  ModelSessionRecord,
  ModelUsageRecord,
  ModelUsageSummary,
  StudyDebtRecord,
  TranscriptEntry,
  TranscriptRole
} from '../../types.js';

export interface HarborToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
}

export interface HarborObservationResult {
  source_call_id?: string;
  content?: string | null;
}

export interface HarborObservation {
  results: HarborObservationResult[];
}

export interface HarborStep {
  step_id: number;
  timestamp?: string;
  source: 'system' | 'user' | 'agent';
  model_name?: string;
  reasoning_effort?: string;
  message: string;
  reasoning_content?: string;
  tool_calls?: HarborToolCall[];
  observation?: HarborObservation;
  extra?: Record<string, unknown>;
}

export interface HarborTrajectory {
  schema_version: 'ATIF-v1.6';
  session_id: string;
  agent: {
    name: 'harness2';
    version: string;
    model_name?: string;
    tool_definitions?: Array<Record<string, unknown>>;
    extra?: Record<string, unknown>;
  };
  steps: HarborStep[];
  notes?: string;
  final_metrics?: {
    total_steps: number;
  };
  extra?: Record<string, unknown>;
}

export interface HarborRunArtifacts {
  summaryJsonPath: string;
  instructionPath: string;
  sessionMarkdownPath: string;
  transcriptJsonPath: string;
  modelHistoryJsonPath: string;
  usageJsonPath: string;
  questionsJsonPath: string;
  experimentsJsonPath: string;
  runtimeJsonPath: string;
  gitStatusPath: string;
  diffPatchPath: string;
  trajectoryJsonPath: string;
}

export interface HarborRunRuntime {
  cwd: string;
  mode: AgentMode;
  model: string;
  reasoningEffort: 'off' | 'low' | 'medium' | 'high';
  thinking: boolean;
  webSearchMode: 'disabled' | 'cached' | 'live' | null;
  startedAt: string;
  completedAt?: string;
  status?: 'running' | 'completed' | 'interrupted';
  interruptionSignal?: 'SIGINT' | 'SIGTERM' | null;
  usage?: ModelUsageSummary;
}

export interface HarborRunResult {
  sessionId: string;
  outputDir: string;
  runtime: HarborRunRuntime;
  artifacts: HarborRunArtifacts;
  partial?: boolean;
}

export interface HarborRunOptions {
  cwd: string;
  instruction: string;
  outputDir: string;
  sessionId?: string;
  mode?: AgentMode;
  model?: string;
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high';
  thinking?: boolean;
  webSearchMode?: 'disabled' | 'cached' | 'live';
  onTranscriptEntry?: (role: TranscriptRole, text: string) => Promise<void> | void;
  onAssistantStream?: (text: string) => Promise<void> | void;
  onReasoningSummaryStream?: (text: string) => Promise<void> | void;
}

export interface HarborArtifactExportInput {
  cwd: string;
  outputDir: string;
  instruction: string;
  sessionId: string;
  runtime: HarborRunRuntime;
  sessionSettings: ModelSessionRecord;
  transcript: TranscriptEntry[];
  modelHistory: ModelHistoryItem[];
  modelUsage: ModelUsageRecord[];
  studyDebts: StudyDebtRecord[];
  experiments: ExperimentRecord[];
}
