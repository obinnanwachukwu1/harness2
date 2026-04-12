import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSessionPromptAndTools } from '../../model/model-client.js';
import type {
  HarborArtifactExportInput,
  HarborObservationResult,
  HarborStep,
  HarborToolCall,
  HarborTrajectory
} from './types.js';

const REASONING_PREFIX = '@@thinking\t';
let cachedVersion: string | null = null;

export async function buildHarborTrajectory(
  input: HarborArtifactExportInput
): Promise<HarborTrajectory> {
  const stepSourceState = {
    nextReasoningSummaryIndex: 0,
    reasoningSummaries: input.transcript
      .filter((entry) => entry.role === 'system' && entry.text.startsWith(REASONING_PREFIX))
      .map((entry) => entry.text.slice(REASONING_PREFIX.length).trim())
  };
  const settings = input.sessionSettings;
  const toolDefinitions = resolveSessionPromptAndTools(settings).toolDefinitions.map((definition) => ({
    type: definition.type,
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters
  }));
  const steps = buildSteps(input, stepSourceState);

  return {
    schema_version: 'ATIF-v1.6',
    session_id: input.sessionId,
    agent: {
      name: 'harness2',
      version: await getHarnessVersion(),
      model_name: settings.model,
      tool_definitions: toolDefinitions,
      extra: {
        agent_mode: settings.agentMode,
        plan_mode_phase: settings.planModePhase ?? null,
        thinking_enabled: input.runtime.thinking,
        web_search_mode: input.runtime.webSearchMode
      }
    },
    steps,
    notes:
      'Converted from harness2 notebook state for Harbor compatibility. Metrics are limited to durable session data currently stored by harness2.',
    final_metrics: {
      total_steps: steps.length
    },
    extra: {
      cwd: input.cwd,
      questions: input.studyDebts.map((record) => ({
        id: record.id,
        status: record.status,
        summary: record.summary,
        resolution: record.resolution
      })),
      experiments: input.experiments.map((record) => ({
        id: record.id,
        status: record.status,
        study_debt_id: record.studyDebtId,
        hypothesis: record.hypothesis,
        summary: record.finalSummary
      }))
    }
  };
}

function buildSteps(
  input: HarborArtifactExportInput,
  state: {
    nextReasoningSummaryIndex: number;
    reasoningSummaries: string[];
  }
): HarborStep[] {
  const steps: Array<Omit<HarborStep, 'step_id'>> = [];
  const history = input.modelHistory;

  for (let index = 0; index < history.length; index += 1) {
    const item = history[index]!;

    if (item.type === 'message') {
      const reasoningContent = item.role === 'assistant' ? takeReasoningSummary(state) : undefined;
      steps.push(
        finalizeStep({
          source: mapMessageRoleToStepSource(item.role),
          message: item.content,
          model_name: item.role === 'assistant' ? input.sessionSettings.model : undefined,
          reasoning_effort:
            item.role === 'assistant'
              ? normalizeReasoningEffort(input.sessionSettings.reasoningEffort)
              : undefined,
          reasoning_content: reasoningContent,
          extra:
            item.role === 'developer'
              ? {
                  original_role: item.role
                }
              : undefined
        })
      );
      continue;
    }

    if (item.type !== 'function_call') {
      steps.push(
        finalizeStep({
          source: 'agent',
          message: '',
          model_name: input.sessionSettings.model,
          reasoning_effort: normalizeReasoningEffort(input.sessionSettings.reasoningEffort),
          observation: {
            results: [
              {
                source_call_id: item.call_id,
                content: item.output
              }
            ]
          },
          extra: {
            synthesized_from: 'function_call_output_without_leading_call'
          }
        })
      );
      continue;
    }

    const toolCall: HarborToolCall = {
      tool_call_id: item.call_id,
      function_name: item.name,
      arguments: parseToolArguments(item.arguments)
    };
    const observationResults: HarborObservationResult[] = [];
    let lookaheadIndex = index + 1;
    while (lookaheadIndex < history.length) {
      const lookahead = history[lookaheadIndex];
      if (!lookahead || lookahead.type !== 'function_call_output' || lookahead.call_id !== item.call_id) {
        break;
      }
      observationResults.push({
        source_call_id: item.call_id,
        content: lookahead.output
      });
      lookaheadIndex += 1;
    }

    steps.push(
      finalizeStep({
        source: 'agent',
        message: '',
        model_name: input.sessionSettings.model,
        reasoning_effort: normalizeReasoningEffort(input.sessionSettings.reasoningEffort),
        reasoning_content: takeReasoningSummary(state),
        tool_calls: [toolCall],
        observation: observationResults.length > 0 ? { results: observationResults } : undefined
      })
    );
    index = lookaheadIndex - 1;
  }

  if (steps.length === 0) {
    for (const entry of input.transcript) {
      steps.push(
        finalizeStep({
          source: mapTranscriptRoleToStepSource(entry.role),
          timestamp: entry.createdAt,
          message: entry.text.startsWith(REASONING_PREFIX)
            ? entry.text.slice(REASONING_PREFIX.length)
            : entry.text
        })
      );
    }
  }

  return steps.map((step, index) => ({
    ...step,
    step_id: index + 1
  }));
}

function finalizeStep(input: Omit<HarborStep, 'step_id'>): Omit<HarborStep, 'step_id'> {
  return {
    ...input,
    message: input.message
  };
}

function takeReasoningSummary(state: {
  nextReasoningSummaryIndex: number;
  reasoningSummaries: string[];
}): string | undefined {
  const next = state.reasoningSummaries[state.nextReasoningSummaryIndex];
  if (!next) {
    return undefined;
  }
  state.nextReasoningSummaryIndex += 1;
  return next;
}

function parseToolArguments(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }

  return rawArguments.trim().length > 0 ? { raw: rawArguments } : {};
}

function mapMessageRoleToStepSource(role: 'user' | 'assistant' | 'system' | 'developer'): 'system' | 'user' | 'agent' {
  if (role === 'user') {
    return 'user';
  }
  if (role === 'assistant') {
    return 'agent';
  }
  return 'system';
}

function mapTranscriptRoleToStepSource(role: 'user' | 'assistant' | 'tool' | 'system'): 'system' | 'user' | 'agent' {
  if (role === 'user') {
    return 'user';
  }
  if (role === 'assistant' || role === 'tool') {
    return 'agent';
  }
  return 'system';
}

function normalizeReasoningEffort(
  reasoningEffort: 'low' | 'medium' | 'high' | null
): string | undefined {
  return reasoningEffort ?? undefined;
}

async function getHarnessVersion(): Promise<string> {
  if (cachedVersion) {
    return cachedVersion;
  }

  const packageJsonPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../package.json'
  );
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    version?: string;
  };
  cachedVersion = packageJson.version?.trim() || '0.0.0';
  return cachedVersion;
}
