import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { HeadlessEngine } from '../engine/headless-engine.js';
import { materializeEnvFiles } from './env-materialize.js';
import { exportEvalCaseArtifacts } from './export.js';
import { materializeFixture } from './fixture-materialize.js';
import type {
  EvalCaseDefinition,
  EvalCaseRunContext,
  EvalCaseRunResult,
  EvalClarificationPolicy,
  EvalFixtureDefinition,
  EvalRuntimeConfig
} from './manifest-types.js';
import { buildAutoScore } from './scoring.js';

export async function runEvalCase(input: {
  runId: string;
  caseDefinition: EvalCaseDefinition;
  fixture: EvalFixtureDefinition;
  runRoot: string;
  runtime: EvalRuntimeConfig;
  clarification?: EvalClarificationPolicy;
}): Promise<EvalCaseRunResult> {
  const caseRoot = path.join(input.runRoot, input.caseDefinition.id);
  const workspacePath = path.join(caseRoot, 'workspace');
  const artifactRoot = path.join(caseRoot, 'artifacts');
  await mkdir(caseRoot, { recursive: true });

  const materializedFixture = await materializeFixture(input.fixture, workspacePath);
  const envResult = await materializeEnvFiles(workspacePath, {
    envSource: input.caseDefinition.envOverride?.envSource ?? input.fixture.envSource,
    writeEnvFile: input.caseDefinition.envOverride?.writeEnvFile ?? input.fixture.writeEnvFile,
    writeEnvExample:
      input.caseDefinition.envOverride?.writeEnvExample ?? input.fixture.writeEnvExample
  });

  const runtime = mergeRuntime(input.runtime, input.caseDefinition.runtimeOverride);
  await writeFile(
    path.join(caseRoot, 'manifest.case.json'),
    JSON.stringify(
      {
        case: input.caseDefinition,
        fixture: {
          ...input.fixture,
          materialized: materializedFixture,
          envFilePath: envResult.envFilePath,
          envExamplePath: envResult.envExamplePath
        },
        runtime
      },
      null,
      2
    ),
    'utf8'
  );

  const promptsSent: string[] = [];
  let clarificationFallbackUsed = false;
  const previousSearchMode = process.env.H2_WEB_SEARCH_MODE;
  const previousMaxSteps = process.env.H2_MAX_MODEL_STEPS;
  try {
    if (runtime.webSearchMode !== 'fixed') {
      process.env.H2_WEB_SEARCH_MODE = runtime.webSearchMode;
    }
    if (runtime.maxSteps !== undefined) {
      process.env.H2_MAX_MODEL_STEPS = String(runtime.maxSteps);
    }

    const engine = await HeadlessEngine.open({
      cwd: workspacePath,
      revealExportsInFinder: false
    });
    try {
      const sessionId = engine.snapshot.session.id;
      const context: EvalCaseRunContext = {
        runId: input.runId,
        caseId: input.caseDefinition.id,
        caseRoot,
        workspacePath,
        artifactRoot,
        sessionId,
        runtime
      };

      if (runtime.model) {
        engine.modelClient.setModel(sessionId, runtime.model);
      }
      engine.modelClient.setReasoningEffort(sessionId, runtime.reasoningEffort);
      engine.setThinkingEnabled(runtime.thinking);

      await submitPrompt(engine, input.caseDefinition.prompt);
      promptsSent.push(input.caseDefinition.prompt);

      for (const followup of input.caseDefinition.followups) {
        if (followup.afterTurn !== promptsSent.length) {
          continue;
        }
        await submitPrompt(engine, followup.prompt);
        promptsSent.push(followup.prompt);
      }

      const studyDebts = engine.notebook.listStudyDebts(sessionId);
      const experiments = engine.notebook.listExperiments(sessionId);
      const modelHistory = engine.notebook.listModelHistory(sessionId);
      const autoScore = buildAutoScore(
        input.caseDefinition,
        modelHistory,
        studyDebts,
        experiments,
        clarificationFallbackUsed
      );
      const artifacts = await exportEvalCaseArtifacts({
        artifactRoot,
        notebook: engine.notebook,
        sessionId,
        runtime,
        autoScore,
        workspacePath
      });

      return {
        caseId: input.caseDefinition.id,
        bucket: input.caseDefinition.bucket,
        fixtureId: input.fixture.id,
        workspacePath: context.workspacePath,
        sessionId: context.sessionId,
        runtime,
        promptsSent,
        clarificationFallbackUsed,
        artifacts,
        autoScore
      };
    } finally {
      await engine.dispose();
    }
  } finally {
    restoreEnvVar('H2_WEB_SEARCH_MODE', previousSearchMode);
    restoreEnvVar('H2_MAX_MODEL_STEPS', previousMaxSteps);
  }
}

async function submitPrompt(engine: HeadlessEngine, prompt: string): Promise<void> {
  await engine.submit(prompt);
}

function mergeRuntime(
  baseRuntime: EvalRuntimeConfig,
  override?: Partial<EvalRuntimeConfig>
): EvalRuntimeConfig {
  return {
    ...baseRuntime,
    ...override
  };
}

function restoreEnvVar(key: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previousValue;
}
