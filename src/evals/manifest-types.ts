export type EvalReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export type EvalWebSearchMode = 'disabled' | 'cached' | 'live' | 'fixed';

export interface EvalSuiteMeta {
  id: string;
  description?: string;
}

export interface EvalRuntimeConfig {
  model?: string;
  reasoningEffort: EvalReasoningEffort;
  thinking: boolean;
  webSearchMode: EvalWebSearchMode;
  maxSteps?: number;
  defaultExperimentBudget?: number;
}

export interface EvalClarificationPolicy {
  autoReply: string;
  markAsUnnecessary: boolean;
}

export type EvalFixtureType = 'template' | 'git_checkout';

export interface EvalFixtureDefinition {
  id: string;
  type: EvalFixtureType;
  path: string;
  ref?: string;
  setupCommand?: string;
  envSource?: string;
  writeEnvFile?: string;
  writeEnvExample?: string;
  validateEnvExample?: boolean;
}

export type EvalBucket = 'A' | 'B' | 'C' | 'W';

export interface EvalCaseEnvOverride {
  envSource?: string;
  writeEnvFile?: string;
  writeEnvExample?: string;
}

export interface EvalFollowupTurn {
  afterTurn: number;
  prompt: string;
}

export interface EvalCaseDefinition {
  id: string;
  bucket: EvalBucket;
  fixture: string;
  prompt: string;
  notes?: string;
  questionExpected?: boolean;
  experimentExpected?: boolean;
  runtimeOverride?: Partial<EvalRuntimeConfig>;
  envOverride?: EvalCaseEnvOverride;
  followups: EvalFollowupTurn[];
  reviewHints: string[];
}

export interface EvalSuiteManifest {
  suite: EvalSuiteMeta;
  runtime: EvalRuntimeConfig;
  clarification?: EvalClarificationPolicy;
  fixtures: EvalFixtureDefinition[];
  cases: EvalCaseDefinition[];
}

export interface EvalRunRequest {
  manifestPath: string;
  runId?: string;
  selectedCaseIds?: string[];
}

export interface EvalRunContext {
  runId: string;
  runRoot: string;
  manifestPath: string;
  lockedManifestPath: string;
  suiteId: string;
  startedAt: string;
}

export interface EvalCaseRunContext {
  runId: string;
  caseId: string;
  caseRoot: string;
  workspacePath: string;
  artifactRoot: string;
  sessionId: string;
  runtime: EvalRuntimeConfig;
}

export interface MaterializedFixture {
  fixtureId: string;
  workspacePath: string;
  sourcePath: string;
  sourceRef?: string | null;
  envFilePath?: string | null;
  envExamplePath?: string | null;
}

export type EvalResolutionMode =
  | 'none'
  | 'static_evidence_sufficient'
  | 'scope_narrowed'
  | 'study_run'
  | 'user_override';

export interface EvalAutoScore {
  testId: string;
  questionExpected: boolean | null;
  questionActual: boolean;
  questionQuality: 0 | 1 | 2 | null;
  experimentExpected: boolean | null;
  experimentActual: 0 | 1 | '2+';
  localPassBeforeExperiment: 'yes' | 'no' | 'n/a';
  experimentHypothesisFalsifiable: 'yes' | 'no' | 'n/a';
  duplicateInlineProbingAfterSpawn: 'yes' | 'no' | 'n/a';
  silentContractChoice: 'yes' | 'no' | 'n/a';
  finalResolutionMode: EvalResolutionMode;
  clarificationFallbackUsed: 'yes' | 'no';
  overall: 'pass' | 'soft fail' | 'hard fail';
  hardFailReasons: string[];
  notes: string[];
}

export interface EvalCaseArtifacts {
  sessionMarkdownPath: string;
  transcriptJsonPath: string;
  modelHistoryJsonPath: string;
  questionsJsonPath: string;
  experimentsJsonPath: string;
  runtimeJsonPath: string;
  gitStatusPath: string;
  diffPatchPath: string;
  autoScorePath: string;
}

export interface EvalCaseRunResult {
  caseId: string;
  bucket: EvalBucket;
  fixtureId: string;
  workspacePath: string;
  sessionId: string;
  runtime: EvalRuntimeConfig;
  promptsSent: string[];
  clarificationFallbackUsed: boolean;
  artifacts: EvalCaseArtifacts;
  autoScore: EvalAutoScore;
}

export interface EvalSuiteRunResult {
  runId: string;
  suiteId: string;
  manifestPath: string;
  lockedManifestPath: string;
  startedAt: string;
  completedAt: string;
  cases: EvalCaseRunResult[];
}
