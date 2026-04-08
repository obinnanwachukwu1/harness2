# Eval Type Model

This is the proposed TypeScript type model for eval support. It is intentionally split into small domains so the eventual implementation does not collapse into a single orchestration file.

## Manifest Domain

```ts
export type EvalReasoningEffort = "off" | "low" | "medium" | "high";

export type EvalWebSearchMode = "disabled" | "cached" | "live" | "fixed";

export interface EvalSuiteManifest {
  suite: EvalSuiteMeta;
  runtime: EvalRuntimeConfig;
  clarification?: EvalClarificationPolicy;
  fixtures: EvalFixtureDefinition[];
  cases: EvalCaseDefinition[];
}

export interface EvalSuiteMeta {
  id: string;
  description?: string;
}

export interface EvalRuntimeConfig {
  model?: string;
  reasoningEffort: EvalReasoningEffort;
  thinking?: boolean;
  webSearchMode?: EvalWebSearchMode;
  maxSteps?: number;
  defaultExperimentBudget?: number;
}

export interface EvalClarificationPolicy {
  autoReply: string;
  markAsUnnecessary?: boolean;
}
```

## Fixture Domain

```ts
export type EvalFixtureType = "template" | "git_checkout";

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

export interface MaterializedFixture {
  fixtureId: string;
  workspacePath: string;
  sourcePath: string;
  sourceRef?: string | null;
  envFilePath?: string | null;
  envExamplePath?: string | null;
}
```

## Case Domain

```ts
export type EvalBucket = "A" | "B" | "C" | "W";

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
  followups?: EvalFollowupTurn[];
  reviewHints?: string[];
}

export interface EvalCaseEnvOverride {
  envSource?: string;
  writeEnvFile?: string;
  writeEnvExample?: string;
}

export interface EvalFollowupTurn {
  afterTurn: number;
  prompt: string;
}
```

## Run Domain

```ts
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
```

## Artifact Domain

```ts
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
```

## Scoring Domain

Machine scoring should operate on notebook state and model history first, with transcript as fallback.

```ts
export type EvalResolutionMode =
  | "none"
  | "static_evidence_sufficient"
  | "scope_narrowed"
  | "study_run"
  | "user_override";

export type EvalOverall = "pass" | "soft fail" | "hard fail";

export interface EvalAutoScore {
  testId: string;
  questionExpected: boolean | null;
  questionActual: boolean;
  experimentExpected: boolean | null;
  experimentActual: 0 | 1 | "2+";
  localPassBeforeExperiment: "yes" | "no" | "n/a";
  experimentHypothesisFalsifiable: "yes" | "no" | "n/a";
  duplicateInlineProbingAfterSpawn: "yes" | "no" | "n/a";
  unnecessaryClarification: "yes" | "no";
  finalResolutionMode: EvalResolutionMode;
  hardFailReasons: string[];
  notes: string[];
}

export interface EvalReviewScore {
  testId: string;
  questionQuality: 0 | 1 | 2 | null;
  silentContractChoice: "yes" | "no" | null;
  overall: EvalOverall | null;
  notes: string;
}
```

## Result Domain

```ts
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
```

## Recommended Module Split

The implementation should stay split by responsibility.

### `src/evals/manifest-types.ts`

- raw interfaces and shared literal unions

### `src/evals/manifest-parse.ts`

- TOML decoding
- normalization
- validation
- lockfile generation

### `src/evals/fixture-materialize.ts`

- template copy
- git checkout/worktree provisioning
- setup command execution

### `src/evals/env-materialize.ts`

- env source resolution
- `.env` writing
- `.env.example` generation
- secret redaction helpers

### `src/evals/case-runner.ts`

- one case lifecycle
- turn submission
- follow-up scheduling
- clarification fallback injection

### `src/evals/suite-runner.ts`

- suite orchestration
- case selection
- run directory creation
- summary assembly

### `src/evals/scoring.ts`

- structural scoring
- hard-fail and soft-fail rule evaluation
- score-sheet row generation

### `src/evals/export.ts`

- artifact persistence
- markdown/json exports
- summary table emission

## Notes On Avoiding God Files

The easy failure mode here is a single `eval-runner.ts` that:

- parses TOML
- copies fixtures
- writes env
- runs sessions
- scores
- exports
- implements CLI dispatch

That file would become a maintenance trap immediately. The split above keeps each piece testable and keeps env/fixture handling from bleeding into scoring or CLI code.
