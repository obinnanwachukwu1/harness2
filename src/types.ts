export type TranscriptRole = 'user' | 'assistant' | 'tool' | 'system';

export type AgentMode = 'study' | 'plan' | 'direct';

export type PlanModePhase = 'planning' | 'awaiting_approval' | 'execution' | null;

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export type ExperimentStatus =
  | 'running'
  | 'budget_exhausted'
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

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  position: number;
}

export type AskUserKind = 'clarification' | 'approval';
export type AskUserResponseKind = 'open' | 'yes_no' | 'single_choice';
export type AskUserRecommendedResponse = 'yes' | 'no' | null;

export interface AskUserOption {
  id: string;
  label: string;
  description: string;
}

export interface PendingUserRequest {
  sessionId: string;
  kind: AskUserKind;
  responseKind: AskUserResponseKind;
  question: string;
  context: string | null;
  options: AskUserOption[] | null;
  recommendedOptionId: string | null;
  recommendedResponse: AskUserRecommendedResponse;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionPlanRecord {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  goal: string;
  assumptions: string[];
  files: string[];
  steps: string[];
  validation: string[];
  risks: string[];
  planPath: string;
}

export interface CompactionArtifactPointer {
  path: string;
  why: string;
}

export interface HiddenCompactionStateSnapshot {
  mode: 'plan' | 'direct' | 'experiment';
  planModePhase: PlanModePhase;
  approvedPlan: SessionPlanRecord | null;
  todos: TodoItem[];
  lastTestStatus: string | null;
  activeProcessSummary: string[];
  experimentState:
    | null
    | {
        id: string;
        hypothesis: string;
        budget: number;
        tokensUsed: number;
        worktreePath: string;
        branchName: string;
      };
}

export interface PlanDirectCompactionSummary {
  mode: 'plan' | 'direct' | 'experiment';
  task: {
    goal: string;
    constraints: string[];
    non_goals: string[];
  };
  state: {
    status: string;
    completed: string[];
    current_focus: string;
    next: string[];
    blockers: string[];
  };
  durable_decisions: Array<{
    decision: string;
    why: string;
  }>;
  implementation_context: {
    changed_files: string[];
    relevant_paths: string[];
    artifacts: CompactionArtifactPointer[];
  };
  validation: {
    last_test_status: string | null;
    passed_checks: string[];
    open_failures: string[];
  };
  plan_mode_state:
    | null
    | {
        approved_plan_summary: string[];
        step_status: Array<{
          step: string;
          status: 'done' | 'in_progress' | 'pending';
        }>;
      };
  resume_hints: string[];
}

export interface CreatePlanInput {
  goal: string;
  assumptions: string[];
  files: string[];
  steps: string[];
  validation: string[];
  risks: string[];
  planMarkdown: string;
}

export interface CreatePlanResult {
  sessionId: string;
  status: 'planned';
  planPath: string;
}

export interface ApprovePlanResult {
  sessionId: string;
  status: 'execution';
}

export interface PlanStatusResult {
  phase: PlanModePhase;
  plan: SessionPlanRecord | null;
}

export interface AskUserInput {
  kind: AskUserKind;
  responseKind: AskUserResponseKind;
  question: string;
  context?: string;
  options?: AskUserOption[];
  recommendedOptionId?: string;
  recommendedResponse?: 'yes' | 'no';
  reason?: string;
}

export interface AskUserResult {
  sessionId: string;
  status: 'waiting_for_user';
  kind: AskUserKind;
  responseKind: AskUserResponseKind;
  question: string;
  options: AskUserOption[] | null;
  recommendedOptionId: string | null;
  recommendedResponse: AskUserRecommendedResponse;
  reason: string | null;
}

export interface UpdateTodosInput {
  items: Array<{
    id: string;
    text: string;
    status: TodoStatus;
  }>;
}

export interface UpdateTodosResult {
  items: TodoItem[];
}

export interface TranscriptEntry {
  id: number;
  sessionId: string;
  role: TranscriptRole;
  text: string;
  createdAt: string;
}

export type ModelMessageRole = 'user' | 'assistant' | 'system' | 'developer';

export type ModelHistoryItem =
  | {
      type: 'message';
      role: ModelMessageRole;
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
  studyDebtId: string | null;
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
  artifacts: string[];
  constraints: string[];
  confidenceNote: string | null;
  lowSignalWarningEmitted: boolean;
  promote: boolean;
}

export interface ExperimentObservation {
  id: number;
  experimentId: string;
  message: string;
  createdAt: string;
  tags: ExperimentObservationTag[];
}

export type StudyDebtStatus = 'open' | 'closed';

export type StudyDebtKind = 'runtime' | 'scope' | 'architecture';

export type StudyDebtResolution =
  | 'study_run'
  | 'static_evidence_sufficient'
  | 'scope_narrowed'
  | 'user_override';

export interface StudyDebtRecord {
  id: string;
  sessionId: string;
  status: StudyDebtStatus;
  kind: StudyDebtKind;
  summary: string;
  whyItMatters: string;
  affectedPaths: string[] | null;
  evidencePaths: string[] | null;
  recommendedStudy: string | null;
  openedAt: string;
  updatedAt: string;
  closedAt: string | null;
  resolution: StudyDebtResolution | null;
  resolutionNote: string | null;
}

export interface SessionExportResult {
  sessionId: string;
  exportPath: string;
  revealedInFinder: boolean;
}

export interface ExperimentResolution {
  id: string;
  verdict: ExperimentStatus;
  summary: string;
  discovered: string[];
  artifacts: string[];
  constraints: string[];
  confidenceNote: string | null;
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

export interface ExperimentSearchGuardrail {
  ok: false;
  guardrail: string;
  suggestedNext: string[];
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
  lowSignalWarningEmitted: boolean;
}

export interface ExperimentAdoptionPreview {
  experimentId: string;
  branchName: string;
  baseCommitSha: string;
  worktreePath: string;
  patchPath: string;
  rollbackBranchName: string;
  applyable: boolean;
  changedFiles: string[];
  untrackedFiles: string[];
  diffStat: string;
}

export interface ExperimentAdoptionResult extends ExperimentAdoptionPreview {
  appliedAt: string;
}

export interface ExperimentBudgetNotification {
  id: string;
  hypothesis: string;
  budget: number;
  tokensUsed: number;
  contextTokensUsed: number;
  toolOutputTokensUsed: number;
  observationTokensUsed: number;
  worktreePath: string;
  branchName: string;
  message: string;
}

export interface ExperimentQualityNotification {
  id: string;
  hypothesis: string;
  tokensUsed: number;
  toolOutputTokensUsed: number;
  budget: number;
  message: string;
}

export interface SessionCheckpointRecord {
  id: number;
  sessionId: string;
  createdAt: string;
  checkpointKind: 'study' | 'plan_direct' | 'experiment_subagent';
  goal: string;
  completed: string;
  next: string;
  openRisks: string | null;
  currentCommitments: string | null;
  importantNonGoals: string | null;
  gitLog: string;
  gitStatus: string;
  gitDiffStat: string;
  lastTestStatus: string | null;
  activeExperimentSummaries: ExperimentSearchResult[];
  invalidatedExperimentSummaries: ExperimentSearchResult[];
  checkpointBlock: string;
  checkpointSummary: PlanDirectCompactionSummary | null;
  artifacts: CompactionArtifactPointer[];
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
  agentMode: AgentMode;
  planModePhase: PlanModePhase;
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
  studyDebts: StudyDebtRecord[];
  activePlan: SessionPlanRecord | null;
  pendingUserRequest: PendingUserRequest | null;
  todos: TodoItem[];
  processingTurn: boolean;
  currentTurnStartedAt: string | null;
  statusText: string;
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | null;
  agentMode: AgentMode;
  planModePhase: PlanModePhase;
  estimatedContextTokens: number;
  contextWindowTokens: number;
  standardRateContextTokens: number | null;
  liveTurnEvents: LiveTurnEvent[];
  thinkingEnabled: boolean;
}

export type LiveTurnEvent =
  | {
      id: string;
      kind: 'assistant';
      text: string;
      live: boolean;
    }
  | {
      id: string;
      kind: 'thinking';
      text: string;
      live: boolean;
    }
  | {
      id: string;
      kind: 'tool';
      transcriptText: string | null;
      live: boolean;
      callId: string | null;
      toolName: string | null;
      label: string | null;
      detail: string | null;
      body: string[];
      providerExecuted: boolean;
    };

export interface SpawnExperimentInput {
  sessionId: string;
  studyDebtId?: string;
  hypothesis: string;
  localEvidenceSummary: string;
  residualUncertainty: string;
  context?: string;
  budgetTokens: number;
  preserve: boolean;
}

export interface ExecCommandInput {
  command: string;
  cwd?: string;
  yieldTimeMs?: number;
  maxOutputChars?: number;
}

export interface ExecCommandResult {
  processId: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  running: boolean;
  command: string;
  cwd: string;
}

export interface WriteStdinInput {
  processId: number;
  input?: string;
  yieldTimeMs?: number;
  maxOutputChars?: number;
  closeStdin?: boolean;
  terminate?: boolean;
}

export interface WriteStdinResult {
  processId: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  running: boolean;
}

export interface AgentTools {
  execCommand(input: ExecCommandInput): Promise<string>;
  writeStdin(input: WriteStdinInput): Promise<string>;
  read(filePath: string, startLine?: number, endLine?: number): Promise<string>;
  ls?(filePath?: string, recursive?: boolean): Promise<string>;
  write?(filePath: string, content: string): Promise<string>;
  edit(patch: string): Promise<string>;
  glob(pattern: string): Promise<string[]>;
  rg?(pattern: string, target?: string | string[]): Promise<string>;
  grep?(pattern: string, target?: string | string[]): Promise<string>;
  spawnExperiment(input: Omit<SpawnExperimentInput, 'sessionId'>): Promise<ExperimentRecord>;
  extendExperimentBudget?(
    experimentId: string,
    additionalTokens: number
  ): Promise<ExperimentRecord>;
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
    lowSignalWarningEmitted: boolean;
  }>;
  searchExperiments?(
    questionId: string,
    query?: string
  ): Promise<ExperimentSearchResult[] | ExperimentSearchGuardrail>;
  openStudyDebt?(input: {
    summary: string;
    whyItMatters: string;
    kind?: StudyDebtKind;
    affectedPaths: string[];
    evidencePaths?: string[];
    recommendedStudy?: string;
  }): Promise<{ questionId: string; status: 'open' }>;
  resolveStudyDebt?(input: {
    questionId: string;
    resolution: StudyDebtResolution;
    note: string;
  }): Promise<{ questionId: string; status: 'closed' }>;
  exportSession?(sessionId?: string): Promise<SessionExportResult>;
  clearExperimentJournal?(
    force?: boolean
  ): Promise<{ clearedExperiments: number; clearedObservations: number; blockedActive: number }>;
  adoptExperiment?(
    experimentId: string,
    options?: { apply?: boolean }
  ): Promise<ExperimentAdoptionPreview | ExperimentAdoptionResult>;
  createPlan?(input: CreatePlanInput): Promise<CreatePlanResult>;
  askUser?(input: AskUserInput): Promise<AskUserResult>;
  updateTodos?(input: UpdateTodosInput): Promise<UpdateTodosResult>;
  approvePlan?(optionId?: string): Promise<ApprovePlanResult>;
  getPlanStatus?(): Promise<PlanStatusResult>;
  compact?(
    goal: string,
    completed: string,
    next: string,
    openRisks?: string,
    currentCommitments?: string,
    importantNonGoals?: string
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
    artifacts?: string[];
    constraints?: string[];
    confidenceNote?: string;
    resolutionNote?: string;
    promote: boolean;
  }): Promise<ExperimentResolution>;
  authLogin(): Promise<string>;
  authStatus(): Promise<string>;
  authLogout(): Promise<string>;
  getModelSettings(): Promise<string>;
  setModel(model: string): Promise<string>;
  setReasoningEffort(effort: 'low' | 'medium' | 'high' | 'off'): Promise<string>;
  getThinkingMode(): Promise<string>;
  setThinkingMode(enabled: boolean): Promise<string>;
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
