import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';

import { HeadlessEngine } from '../../engine/headless-engine.js';
import { nowIso } from '../../lib/utils.js';
import type { HarborRunOptions, HarborRunResult, HarborRunRuntime } from './types.js';
import { writeHarborRunArtifacts, writeHarborRunPrelude } from './artifacts.js';

export async function runHarborTask(input: HarborRunOptions): Promise<HarborRunResult> {
  const outputDir = path.resolve(input.outputDir);
  await mkdir(outputDir, { recursive: true });
  await ensureGitWorkspaceForHarbor(input.cwd);

  const engine = await HeadlessEngine.open({
    cwd: input.cwd,
    sessionId: input.sessionId,
    webSearchMode: input.webSearchMode,
    agentMode: input.mode
  });
  const sessionId = engine.snapshot.session.id;
  const startedAt = nowIso();
  let exportedPartial = false;

  const exportPartialArtifacts = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
    if (exportedPartial) {
      return;
    }
    exportedPartial = true;

    const settings = engine.getSessionSettings();
    const runtime: HarborRunRuntime = {
      cwd: input.cwd,
      mode: settings.agentMode,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort ?? 'off',
      thinking: engine.getThinkingEnabled(),
      webSearchMode: input.webSearchMode ?? null,
      startedAt,
      completedAt: nowIso(),
      status: 'interrupted',
      interruptionSignal: signal,
      usage: engine.notebook.getModelUsageSummary(sessionId)
    };

    await writeHarborRunArtifacts(
      {
        cwd: input.cwd,
        outputDir,
        instruction: input.instruction,
        sessionId,
        runtime,
        sessionSettings: settings,
        transcript: engine.notebook.listTranscript(sessionId, Number.MAX_SAFE_INTEGER),
        modelHistory: engine.notebook.listModelHistory(sessionId),
        modelUsage: engine.notebook.listModelUsage(sessionId),
        studyDebts: engine.notebook.listStudyDebts(sessionId),
        experiments: engine.notebook.listExperiments(sessionId)
      },
      { partial: true }
    );
  };

  const handleSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    void (async () => {
      try {
        await exportPartialArtifacts(signal);
      } finally {
        await engine.dispose();
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }
    })();
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    if (input.model) {
      engine.modelClient.setModel(sessionId, input.model);
    }
    if (input.reasoningEffort) {
      engine.modelClient.setReasoningEffort(sessionId, input.reasoningEffort);
    }
    engine.setThinkingEnabled(input.thinking ?? true);

    const initialSettings = engine.getSessionSettings();
    await writeHarborRunPrelude({
      outputDir,
      instruction: input.instruction,
      sessionId,
      runtime: {
        cwd: input.cwd,
        mode: initialSettings.agentMode,
        model: initialSettings.model,
        reasoningEffort: initialSettings.reasoningEffort ?? 'off',
        thinking: engine.getThinkingEnabled(),
        webSearchMode: input.webSearchMode ?? null,
        startedAt,
        status: 'running',
        interruptionSignal: null,
        usage: engine.notebook.getModelUsageSummary(sessionId)
      }
    });

    await engine.submit(input.instruction, {
      onTranscriptEntry: input.onTranscriptEntry,
      onAssistantStream: input.onAssistantStream,
      onReasoningSummaryStream: input.onReasoningSummaryStream
    });

    const settings = engine.getSessionSettings();
    const runtime: HarborRunRuntime = {
      cwd: input.cwd,
      mode: settings.agentMode,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort ?? 'off',
      thinking: engine.getThinkingEnabled(),
      webSearchMode: input.webSearchMode ?? null,
      startedAt,
      completedAt: nowIso(),
      status: 'completed',
      interruptionSignal: null,
      usage: engine.notebook.getModelUsageSummary(sessionId)
    };

    const { artifacts } = await writeHarborRunArtifacts({
      cwd: input.cwd,
      outputDir,
      instruction: input.instruction,
      sessionId,
      runtime,
      sessionSettings: settings,
      transcript: engine.notebook.listTranscript(sessionId, Number.MAX_SAFE_INTEGER),
      modelHistory: engine.notebook.listModelHistory(sessionId),
      modelUsage: engine.notebook.listModelUsage(sessionId),
      studyDebts: engine.notebook.listStudyDebts(sessionId),
      experiments: engine.notebook.listExperiments(sessionId)
    });

    return {
      sessionId,
      outputDir,
      runtime,
      artifacts,
      partial: false
    };
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    await engine.dispose();
  }
}

export async function ensureGitWorkspaceForHarbor(cwd: string): Promise<{
  bootstrapped: boolean;
  reason: 'already_initialized' | 'initialized_repository' | 'created_initial_commit';
}> {
  const repoResult = await execa('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    reject: false
  });

  if (repoResult.exitCode !== 0 || repoResult.stdout.trim() !== 'true') {
    await execa('git', ['init'], { cwd });
    await configureBootstrapIdentity(cwd);
    await createInitialCommit(cwd);
    return {
      bootstrapped: true,
      reason: 'initialized_repository'
    };
  }

  const headResult = await execa('git', ['rev-parse', 'HEAD'], {
    cwd,
    reject: false
  });
  if (headResult.exitCode === 0) {
    return {
      bootstrapped: false,
      reason: 'already_initialized'
    };
  }

  await configureBootstrapIdentity(cwd);
  await createInitialCommit(cwd);
  return {
    bootstrapped: true,
    reason: 'created_initial_commit'
  };
}

async function configureBootstrapIdentity(cwd: string): Promise<void> {
  await execa('git', ['config', 'user.name', 'Harness Two'], { cwd });
  await execa('git', ['config', 'user.email', 'h2@example.com'], { cwd });
}

async function createInitialCommit(cwd: string): Promise<void> {
  await execa('git', ['add', '.'], { cwd });
  await execa('git', ['commit', '--allow-empty', '-m', 'h2 harbor workspace bootstrap'], {
    cwd
  });
}
