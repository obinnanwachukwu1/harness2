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
  let scenarioTurnCount = 0;
  let clarificationFallbackUsed = false;
  return withEvalContextWindowOverride(runtime.contextWindowTokens, async () => {
    const engine = await HeadlessEngine.open({
      cwd: workspacePath,
      revealExportsInFinder: false,
      webSearchMode: runtime.webSearchMode === 'fixed' ? undefined : runtime.webSearchMode,
      agentMode: runtime.mode,
      forceStudyCompactionOnce: runtime.forceUnresolvedCompactionOnce
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

      await submitEvalScenarioPrompt(input.caseDefinition.prompt);

      for (const followup of input.caseDefinition.followups) {
        if (followup.afterTurn !== scenarioTurnCount) {
          continue;
        }
        await submitEvalScenarioPrompt(followup.prompt);
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

      async function submitEvalScenarioPrompt(prompt: string): Promise<void> {
        await submitPrompt(engine, prompt);
        promptsSent.push(prompt);
        scenarioTurnCount += 1;
        await drainPlanAutoReplies();
      }

      async function drainPlanAutoReplies(): Promise<void> {
        if (runtime.mode !== 'plan') {
          return;
        }

        let guard = 0;
        while (guard < 8) {
          guard += 1;
          const pending = engine.notebook.getPendingUserRequest(sessionId);
          if (!pending) {
            break;
          }

          let reply: string;
          if (pending.responseKind === 'yes_no') {
            const recommended = pending.recommendedResponse ?? 'yes';
            reply =
              recommended === 'no'
                ? `No. ${pending.reason ?? 'Please revise the plan.'}`.trim()
                : `Yes. ${pending.reason ?? 'Proceed with the plan.'}`.trim();
          } else if (pending.responseKind === 'single_choice') {
            clarificationFallbackUsed = true;
            const recommended =
              pending.recommendedOptionId ?? pending.options?.[0]?.id ?? 'the recommended option';
            reply = `I choose ${recommended}. ${pending.reason ?? ''}`.trim();
          } else {
            clarificationFallbackUsed = true;
            reply =
              input.clarification?.autoReply ?? 'Use the narrowest bounded assumption and continue.';
          }

          await submitPrompt(engine, reply);
          promptsSent.push(reply);
        }

        const finalPending = engine.notebook.getPendingUserRequest(sessionId);
        if (finalPending) {
          throw new Error('Plan mode is still waiting for user input after eval auto-replies.');
        }
      }
    } finally {
      await engine.dispose();
    }
  });
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

async function withEvalContextWindowOverride<T>(
  contextWindowTokens: number | undefined,
  work: () => Promise<T>
): Promise<T> {
  const previous = process.env.H2_CONTEXT_WINDOW_TOKENS;
  if (contextWindowTokens) {
    process.env.H2_CONTEXT_WINDOW_TOKENS = String(contextWindowTokens);
  } else {
    delete process.env.H2_CONTEXT_WINDOW_TOKENS;
  }

  try {
    return await work();
  } finally {
    if (previous === undefined) {
      delete process.env.H2_CONTEXT_WINDOW_TOKENS;
    } else {
      process.env.H2_CONTEXT_WINDOW_TOKENS = previous;
    }
  }
}
