import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { OPENAI_CODEX_ORIGINATOR } from '../auth/openai-codex.js';
import { clampText } from '../lib/utils.js';
import type {
  CompactionArtifactPointer,
  HiddenCompactionStateSnapshot,
  ModelHistoryItem,
  PlanDirectCompactionSummary,
  SessionPlanRecord,
  TodoItem
} from '../types.js';

export const PLAN_DIRECT_COMPACTOR_MODEL = 'gpt-5.4-mini';
export const PLAN_DIRECT_COMPACTOR_PROMPT = `You are the hidden continuation compactor for a coding-agent session.

Your job is to compress older session context into a resume checkpoint for the next context window.

Preserve only information that is still needed to continue the task correctly:
- current objective
- constraints and non-goals that still matter
- completed work that changes what should happen next
- durable technical decisions
- important blockers, caveats, and failures
- validation status
- file/artifact pointers the agent may need to revisit

Rules:
- Do not invent requirements, plans, todos, code changes, or test results.
- Prefer concrete facts over narrative.
- Drop conversational filler, repetition, and obsolete reasoning.
- If a detail already exists in structured state (approved plan, todo list, git status, last test status, artifact paths), do not restate it unless it materially changes interpretation.
- For direct mode, do not rewrite the work into a formal plan.
- For plan mode, preserve the currently approved plan and its execution status, but do not expand or improve it.
- For experiment mode, preserve the bounded hypothesis, useful findings, and next step, but do not broaden the experiment scope.
- When uncertain whether a detail still matters, omit it.
- Output valid JSON only, matching the schema exactly.`;

const PLAN_DIRECT_COMPACTOR_SCHEMA = {
  name: 'plan_direct_compaction_checkpoint',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: ['plan', 'direct', 'experiment'] },
      task: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goal: { type: 'string' },
          constraints: { type: 'array', items: { type: 'string' } },
          non_goals: { type: 'array', items: { type: 'string' } }
        },
        required: ['goal', 'constraints', 'non_goals']
      },
      state: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string' },
          completed: { type: 'array', items: { type: 'string' } },
          current_focus: { type: 'string' },
          next: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } }
        },
        required: ['status', 'completed', 'current_focus', 'next', 'blockers']
      },
      durable_decisions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            decision: { type: 'string' },
            why: { type: 'string' }
          },
          required: ['decision', 'why']
        }
      },
      implementation_context: {
        type: 'object',
        additionalProperties: false,
        properties: {
          changed_files: { type: 'array', items: { type: 'string' } },
          relevant_paths: { type: 'array', items: { type: 'string' } },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                why: { type: 'string' }
              },
              required: ['path', 'why']
            }
          }
        },
        required: ['changed_files', 'relevant_paths', 'artifacts']
      },
      validation: {
        type: 'object',
        additionalProperties: false,
        properties: {
          last_test_status: { type: ['string', 'null'] },
          passed_checks: { type: 'array', items: { type: 'string' } },
          open_failures: { type: 'array', items: { type: 'string' } }
        },
        required: ['last_test_status', 'passed_checks', 'open_failures']
      },
      plan_mode_state: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              approved_plan_summary: { type: 'array', items: { type: 'string' } },
              step_status: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    step: { type: 'string' },
                    status: { type: 'string', enum: ['done', 'in_progress', 'pending'] }
                  },
                  required: ['step', 'status']
                }
              }
            },
            required: ['approved_plan_summary', 'step_status']
          }
        ]
      },
      resume_hints: { type: 'array', items: { type: 'string' } }
    },
    required: [
      'mode',
      'task',
      'state',
      'durable_decisions',
      'implementation_context',
      'validation',
      'plan_mode_state',
      'resume_hints'
    ]
  },
  strict: true
} as const;

export interface PlanDirectCompactorInput {
  mode: 'plan' | 'direct' | 'experiment';
  previousCheckpoint: PlanDirectCompactionSummary | null;
  structuredState: HiddenCompactionStateSnapshot;
  transcriptMiddle: ModelHistoryItem[];
  gitLog: string;
  gitStatus: string;
  gitDiffStat: string;
  artifactPointers: CompactionArtifactPointer[];
  originalUserRequest: string;
}

export interface PlanDirectCompactorRequest {
  fetchImpl: typeof fetch;
  endpoint: string;
  accessToken: string;
  accountId: string;
  sessionId: string;
  input: PlanDirectCompactorInput;
}

export interface PlanDirectCompactionArtifacts {
  compactionId: string;
  compactionDir: string;
  historyPath: string;
  summaryPath: string;
  artifactsPath: string;
  pointers: CompactionArtifactPointer[];
}

export async function runPlanDirectCompactor(
  input: PlanDirectCompactorRequest
): Promise<PlanDirectCompactionSummary> {
  const response = await input.fetchImpl(input.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      originator: OPENAI_CODEX_ORIGINATOR,
      session_id: input.sessionId,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(input.accountId ? { 'chatgpt-account-id': input.accountId } : {})
    },
    body: JSON.stringify({
      stream: true,
      store: false,
      model: PLAN_DIRECT_COMPACTOR_MODEL,
      instructions: PLAN_DIRECT_COMPACTOR_PROMPT,
      text: {
        format: {
          type: 'json_schema',
          name: PLAN_DIRECT_COMPACTOR_SCHEMA.name,
          schema: PLAN_DIRECT_COMPACTOR_SCHEMA.schema,
          strict: true
        }
      },
      input: [
        {
          role: 'user',
          content: JSON.stringify({
            mode: input.input.mode,
            previous_checkpoint: input.input.previousCheckpoint,
            structured_state: {
              approved_plan: summarizeApprovedPlan(input.input.structuredState.approvedPlan),
              todos: summarizeTodos(input.input.structuredState.todos),
              last_test_status: input.input.structuredState.lastTestStatus,
              active_process_summary: input.input.structuredState.activeProcessSummary,
              experiment_state: input.input.structuredState.experimentState,
              git_log: input.input.gitLog,
              git_status: input.input.gitStatus,
              git_diff_stat: input.input.gitDiffStat,
              artifact_pointers: input.input.artifactPointers
            },
            transcript_middle: input.input.transcriptMiddle,
            boundary_context: {
              original_user_request: input.input.originalUserRequest
            }
          })
        }
      ]
    })
  });

  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(
      `Hidden compactor failed (${response.status}): ${clampText(text, 1200)}`
    );
  }

  const deltas = text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .flatMap((chunk) =>
      chunk
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
    )
    .filter((line) => line !== '[DONE]')
    .map((line) => JSON.parse(line) as { type: string; delta?: string })
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.delta ?? '')
    .join('');

  let parsed: unknown;
  try {
    parsed = JSON.parse(deltas);
  } catch (error) {
    throw new Error(`Hidden compactor returned invalid JSON: ${String(error)}`);
  }

  if (!isPlanDirectCompactionSummary(parsed)) {
    throw new Error('Hidden compactor returned an invalid checkpoint shape.');
  }

  return parsed;
}

export async function writePlanDirectCompactionArtifacts(input: {
  cwd: string;
  transcriptMiddle: ModelHistoryItem[];
  summary: PlanDirectCompactionSummary;
  artifactPointers: CompactionArtifactPointer[];
}): Promise<PlanDirectCompactionArtifacts> {
  const compactionId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const compactionDir = path.join(input.cwd, '.h2', 'compactions', compactionId);
  const historyPath = path.join(compactionDir, 'history.md');
  const summaryPath = path.join(compactionDir, 'summary.json');
  const artifactsPath = path.join(compactionDir, 'artifacts.json');
  await mkdir(compactionDir, { recursive: true });
  await writeFile(historyPath, renderHistoryMarkdown(input.transcriptMiddle), 'utf8');
  await writeFile(summaryPath, JSON.stringify(input.summary, null, 2) + '\n', 'utf8');
  await writeFile(artifactsPath, JSON.stringify(input.artifactPointers, null, 2) + '\n', 'utf8');
  return {
    compactionId,
    compactionDir,
    historyPath,
    summaryPath,
    artifactsPath,
    pointers: [
      { path: historyPath, why: 'full pre-compaction middle transcript' },
      { path: summaryPath, why: 'hidden compactor JSON summary' },
      { path: artifactsPath, why: 'artifact pointers preserved across compaction' }
    ]
  };
}

export function renderPlanDirectCheckpointBlock(input: {
  summary: PlanDirectCompactionSummary;
  structuredState: HiddenCompactionStateSnapshot;
  gitLog: string;
  gitStatus: string;
  gitDiffStat: string;
  compactionArtifacts: PlanDirectCompactionArtifacts;
}): string {
  const todoLines =
    input.structuredState.todos.length > 0
      ? input.structuredState.todos.map(
          (todo) => `- ${todo.status} | ${todo.text}`
        )
      : ['- none'];
  const planLines =
    input.structuredState.approvedPlan !== null
      ? [
          `goal: ${input.structuredState.approvedPlan.goal}`,
          `plan_path: ${input.structuredState.approvedPlan.planPath}`,
          'steps:',
          ...input.structuredState.approvedPlan.steps.map((step) => `- ${step}`)
        ]
      : ['none'];
  const activeProcessLines =
    input.structuredState.activeProcessSummary.length > 0
      ? input.structuredState.activeProcessSummary.map((line) => `- ${line}`)
      : ['- none'];
  const experimentLines =
    input.structuredState.experimentState !== null
      ? [
          `id: ${input.structuredState.experimentState.id}`,
          `hypothesis: ${input.structuredState.experimentState.hypothesis}`,
          `budget: ${input.structuredState.experimentState.tokensUsed}/${input.structuredState.experimentState.budget}`,
          `worktree_path: ${input.structuredState.experimentState.worktreePath}`,
          `branch_name: ${input.structuredState.experimentState.branchName}`
        ]
      : ['none'];
  const artifactLines = input.compactionArtifacts.pointers.map(
    (pointer) => `- ${pointer.path} | ${pointer.why}`
  );

  return [
    'Harness checkpoint',
    '',
    'Hidden continuation summary (JSON):',
    JSON.stringify(input.summary, null, 2),
    '',
    'Structured state (authoritative):',
    `mode: ${input.structuredState.mode}`,
    `plan_mode_phase: ${input.structuredState.planModePhase ?? 'none'}`,
    `last_test_status: ${input.structuredState.lastTestStatus ?? 'unknown'}`,
    '',
    'approved_plan:',
    ...planLines,
    '',
    'todos:',
    ...todoLines,
    '',
    'active_processes:',
    ...activeProcessLines,
    '',
    'experiment_state:',
    ...experimentLines,
    '',
    'recent_commits:',
    input.gitLog,
    '',
    'working_tree:',
    input.gitStatus,
    '',
    'diff_stat:',
    input.gitDiffStat,
    '',
    'compaction_artifacts:',
    ...artifactLines
  ].join('\n');
}

function renderHistoryMarkdown(items: ModelHistoryItem[]): string {
  return items
    .map((item, index) => {
      if (item.type === 'message') {
        return [
          `## ${index + 1}. ${item.role}`,
          '',
          '```text',
          item.content,
          '```'
        ].join('\n');
      }

      if (item.type === 'function_call') {
        return [
          `## ${index + 1}. function_call ${item.name}`,
          '',
          '```json',
          item.arguments,
          '```'
        ].join('\n');
      }

      return [
        `## ${index + 1}. function_call_output ${item.call_id}`,
        '',
        '```text',
        item.output,
        '```'
      ].join('\n');
    })
    .join('\n\n');
}

function summarizeApprovedPlan(plan: SessionPlanRecord | null): object | null {
  if (!plan) {
    return null;
  }

  return {
    goal: plan.goal,
    files: plan.files,
    steps: plan.steps,
    validation: plan.validation,
    risks: plan.risks,
    plan_path: plan.planPath
  };
}

function summarizeTodos(todos: TodoItem[]): Array<{ text: string; status: string }> {
  return todos.map((todo) => ({
    text: todo.text,
    status: todo.status
  }));
}

function isPlanDirectCompactionSummary(value: unknown): value is PlanDirectCompactionSummary {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const summary = value as PlanDirectCompactionSummary;
  return (
    (summary.mode === 'plan' || summary.mode === 'direct' || summary.mode === 'experiment') &&
    Boolean(summary.task && typeof summary.task.goal === 'string') &&
    Array.isArray(summary.task.constraints) &&
    Array.isArray(summary.task.non_goals) &&
    Boolean(summary.state && typeof summary.state.status === 'string') &&
    Array.isArray(summary.state.completed) &&
    typeof summary.state.current_focus === 'string' &&
    Array.isArray(summary.state.next) &&
    Array.isArray(summary.state.blockers) &&
    Array.isArray(summary.durable_decisions) &&
    Boolean(summary.implementation_context) &&
    Array.isArray(summary.implementation_context.changed_files) &&
    Array.isArray(summary.implementation_context.relevant_paths) &&
    Array.isArray(summary.implementation_context.artifacts) &&
    Boolean(summary.validation) &&
    Array.isArray(summary.validation.passed_checks) &&
    Array.isArray(summary.validation.open_failures) &&
    (summary.plan_mode_state === null ||
      (Array.isArray(summary.plan_mode_state.approved_plan_summary) &&
        Array.isArray(summary.plan_mode_state.step_status))) &&
    Array.isArray(summary.resume_hints)
  );
}
