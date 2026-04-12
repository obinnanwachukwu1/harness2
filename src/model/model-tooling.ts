import { jsonSchema, tool } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

import { ExperimentBudgetExceededError } from '../experiments/experiment-manager.js';
import { clampText, DEFAULT_EXPERIMENT_BUDGET_TOKENS } from '../lib/utils.js';
import type {
  AgentTools,
  ExperimentObservationTag,
  StudyDebtKind,
  StudyDebtResolution
} from '../types.js';

export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  callId: string;
  rawArguments: string;
}

export function formatToolOutput(name: string, rawArguments: string, output: string): string {
  if (output.startsWith('@@tool\t')) {
    return output;
  }
  return `@@tool\t${name}\t${formatToolHeader(name, rawArguments, output)}\n${clampText(output, 2400)}`;
}

export function formatToolHeader(name: string, rawArguments: string, output?: string): string {
  try {
    const args = parseArguments(rawArguments);
    const parsedOutput = output ? safeJsonParse(output) : null;

    switch (name) {
      case 'exec_command':
        return `Exec(${compactTextForHeader(readStringArg(args, 'command'), 72)})`;
      case 'write_stdin': {
        const processId = readOptionalNumberArg(args, 'processId');
        return typeof processId === 'number' ? `Exec(${Math.floor(processId)})` : 'Exec(stdin)';
      }
      case 'read':
        return formatReadHeader(
          readStringArg(args, 'path'),
          readOptionalNumberArg(args, 'startLine'),
          readOptionalNumberArg(args, 'endLine')
        );
      case 'ls':
        return `Ls(${readOptionalStringArg(args, 'path') ?? '.'})`;
      case 'write':
        return `Write(${readStringArg(args, 'path')})`;
      case 'edit':
        return summarizePatchForHeader(readStringArg(args, 'patch'));
      case 'glob':
        return `Glob(${readStringArg(args, 'pattern')})`;
      case 'rg': {
        const target = readOptionalStringOrArrayArg(args, 'target');
        const targetText = Array.isArray(target) ? target.join(' ') : target;
        return target
          ? `Rg(${readStringArg(args, 'pattern')} in ${targetText})`
          : `Rg(${readStringArg(args, 'pattern')})`;
      }
      case 'grep': {
        const target = readOptionalStringOrArrayArg(args, 'target');
        const targetText = Array.isArray(target) ? target.join(' ') : target;
        return target
          ? `Rg(${readStringArg(args, 'pattern')} in ${targetText})`
          : `Rg(${readStringArg(args, 'pattern')})`;
      }
      case 'web_search': {
        const query = readOptionalStringArg(args, 'query');
        return query ? `WebSearch(${compactTextForHeader(query, 64)})` : 'WebSearch';
      }
      case 'spawn_experiment': {
        const questionId =
          readOptionalStringArg(args, 'questionId') ?? readOptionalStringArg(args, 'studyDebtId');
        return questionId
          ? `experiment spawn(${questionId}: ${compactTextForHeader(readStringArg(args, 'hypothesis'), 52)})`
          : `experiment spawn(${compactTextForHeader(readStringArg(args, 'hypothesis'), 64)})`;
      }
      case 'narrow_question':
        return `narrow question(${compactTextForHeader(
          readOptionalStringArg(args, 'questionId') ?? readStringArg(args, 'summary'),
          56
        )})`;
      case 'read_experiment':
        return `experiment read(${readStringArg(args, 'experimentId')})`;
      case 'wait_experiment':
        return `experiment wait(${readStringArg(args, 'experimentId')})`;
      case 'search_experiments': {
        const query = readOptionalStringArg(args, 'query');
        const questionId = readStringArg(args, 'questionId');
        return query
          ? `experiment search(${questionId}: ${compactTextForHeader(query, 44)})`
          : `experiment search(${questionId})`;
      }
      case 'open_question':
      case 'open_study_debt':
        return `open question(${compactTextForHeader(
          readOptionalOutputSummary(parsedOutput) ?? readStringArg(args, 'summary'),
          56
        )})`;
      case 'resolve_question':
      case 'resolve_study_debt':
        return `resolve question(${compactTextForHeader(
          readOptionalOutputSummary(parsedOutput) ??
            (readOptionalStringArg(args, 'questionId') ?? readStringArg(args, 'debtId')),
          56
        )})`;
      case 'extend_experiment_budget':
        return `experiment budget(${readStringArg(args, 'experimentId')})`;
      case 'resolve_experiment':
        return `experiment resolve(${readStringArg(args, 'experimentId')})`;
      case 'create_plan':
        return `Plan(${compactTextForHeader(readStringArg(args, 'goal'), 56)})`;
      case 'ask_user':
        return `AskUser(${compactTextForHeader(readStringArg(args, 'question'), 56)})`;
      case 'update_todos': {
        const items = readOptionalArrayArg(args, 'items');
        return `Todos(${Array.isArray(items) ? items.length : 0})`;
      }
      case 'compact':
        return `Compact(${compactTextForHeader(readStringArg(args, 'goal'), 56)})`;
      default:
        return name;
    }
  } catch {
    return name;
  }
}

function fallbackArgumentPreview(rawArguments: string): string[] {
  const parsed = safeJsonParse(rawArguments);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return formatJsonArgumentPreview(parsed as Record<string, unknown>);
  }
  return rawArguments.trim().length > 0 ? [compactTextForHeader(rawArguments.trim(), 120)] : [];
}

export function formatLiveToolBody(name: string, rawArguments: string): string[] {
  try {
    const args = parseArguments(rawArguments);

    switch (name) {
      case 'exec_command': {
        const command = readStringArg(args, 'command');
        const cwd = readOptionalStringArg(args, 'cwd');
        return cwd ? [`command: ${command}`, `cwd: ${cwd}`] : [`command: ${command}`];
      }
      case 'write_stdin': {
        const processId = readNumberArg(args, 'processId');
        const body = [`process: ${processId}`];
        const input = readOptionalStringArg(args, 'input');
        if (input) {
          body.push(`input: ${input}`);
        }
        if (readOptionalBooleanArg(args, 'closeStdin')) {
          body.push('stdin: close');
        }
        if (readOptionalBooleanArg(args, 'terminate')) {
          body.push('process: terminate');
        }
        return body;
      }
      case 'read': {
        const path = readStringArg(args, 'path');
        const startLine = readOptionalNumberArg(args, 'startLine');
        const endLine = readOptionalNumberArg(args, 'endLine');
        const range =
          typeof startLine === 'number' || typeof endLine === 'number'
            ? `lines ${typeof startLine === 'number' ? Math.floor(startLine) : 1}-${typeof endLine === 'number' ? Math.floor(endLine) : 'end'}`
            : null;
        return range ? [`path: ${path}`, range] : [`path: ${path}`];
      }
      case 'ls':
        return [`path: ${readOptionalStringArg(args, 'path') ?? '.'}`];
      case 'write':
        return [`path: ${readStringArg(args, 'path')}`];
      case 'edit':
        return summarizePatchForBody(readStringArg(args, 'patch'));
      case 'glob':
        return [`pattern: ${readStringArg(args, 'pattern')}`];
      case 'rg':
      case 'grep': {
        const pattern = readStringArg(args, 'pattern');
        const target = readOptionalStringOrArrayArg(args, 'target');
        const targetText = Array.isArray(target) ? target.join(' ') : target;
        return targetText ? [`pattern: ${pattern}`, `target: ${targetText}`] : [`pattern: ${pattern}`];
      }
      case 'web_search': {
        const query = readOptionalStringArg(args, 'query');
        return query ? [`query: ${query}`] : [];
      }
      case 'search_experiments': {
        const body = [`questionId: ${readStringArg(args, 'questionId')}`];
        const query = readOptionalStringArg(args, 'query');
        if (query) {
          body.push(`query: ${query}`);
        }
        return body;
      }
      case 'narrow_question': {
        const body = [
          `questionId: ${readStringArg(args, 'questionId')}`,
          `summary: ${readStringArg(args, 'summary')}`,
          `whyItMatters: ${readStringArg(args, 'whyItMatters')}`
        ];
        const affectedPaths = readOptionalArrayArg(args, 'affectedPaths');
        if (Array.isArray(affectedPaths)) {
          body.push(`affectedPaths: ${affectedPaths.length}`);
        }
        const evidencePaths = readOptionalArrayArg(args, 'evidencePaths');
        if (Array.isArray(evidencePaths)) {
          body.push(`evidencePaths: ${evidencePaths.length}`);
        }
        return body;
      }
      case 'create_plan': {
        return [`goal: ${readStringArg(args, 'goal')}`];
      }
      case 'ask_user': {
        const body = [
          `kind: ${readStringArg(args, 'kind')}`,
          `responseKind: ${readStringArg(args, 'responseKind')}`,
          `question: ${readStringArg(args, 'question')}`
        ];
        const options = readOptionalArrayArg(args, 'options');
        if (Array.isArray(options)) {
          body.push(`options: ${options.length}`);
        }
        const recommendedOptionId = readOptionalStringArg(args, 'recommendedOptionId');
        if (recommendedOptionId) {
          body.push(`recommendedOptionId: ${recommendedOptionId}`);
        }
        const recommended = readOptionalStringArg(args, 'recommendedResponse');
        if (recommended) {
          body.push(`recommendedResponse: ${recommended}`);
        }
        const reason = readOptionalStringArg(args, 'reason');
        if (reason) {
          body.push(`reason: ${reason}`);
        }
        return body;
      }
      case 'update_todos': {
        const items = readOptionalArrayArg(args, 'items');
        return [`items: ${Array.isArray(items) ? items.length : 0}`];
      }
      case 'compact': {
        const body = [
          `goal: ${readStringArg(args, 'goal')}`,
          `completed: ${readStringArg(args, 'completed')}`,
          `next: ${readStringArg(args, 'next')}`
        ];
        const openRisks = readOptionalStringArg(args, 'openRisks');
        if (openRisks) {
          body.push(`openRisks: ${openRisks}`);
        }
        const currentCommitments = readOptionalStringArg(args, 'currentCommitments');
        if (currentCommitments) {
          body.push(`currentCommitments: ${currentCommitments}`);
        }
        const importantNonGoals = readOptionalStringArg(args, 'importantNonGoals');
        if (importantNonGoals) {
          body.push(`importantNonGoals: ${importantNonGoals}`);
        }
        return body;
      }
      default:
        return formatJsonArgumentPreview(args);
    }
  } catch {
    return fallbackArgumentPreview(rawArguments);
  }
}

export function normalizeExperimentWaitTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return 5_000;
  }

  if (!Number.isFinite(timeoutMs)) {
    return 5_000;
  }

  return Math.max(3_000, Math.floor(timeoutMs));
}

export async function executeToolCallBatch(
  calls: readonly ToolCall[],
  tools: AgentTools
): Promise<Array<{ output: string; failed: boolean }>> {
  if (calls.length <= 1) {
    return calls.length === 1 ? [await executeToolCallSafely(calls[0]!, tools)] : [];
  }

  return Promise.all(calls.map((call) => executeToolCallSafely(call, tools)));
}

export function isParallelReadOnlyToolCall(call: ToolCall): boolean {
  return ['read', 'ls', 'glob', 'rg', 'grep'].includes(call.name);
}

export function serializeExperimentForModel<T extends object>(value: T): Record<string, unknown> {
  const output: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if ('studyDebtId' in output) {
    output.questionId = output.studyDebtId;
    delete output.studyDebtId;
  }
  return output;
}

export function buildAiSdkTools(
  toolDefinitions: readonly ToolDefinition[],
  provider: ReturnType<typeof createOpenAI>,
  webSearchMode: 'disabled' | 'cached' | 'live'
) {
  const tools = Object.fromEntries(
    toolDefinitions.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.parameters),
      })
    ])
  );

  if (webSearchMode === 'disabled') {
    return tools;
  }

  return {
    ...tools,
    web_search: provider.tools.webSearch({
      externalWebAccess: webSearchMode === 'live',
      searchContextSize: 'medium'
    })
  };
}

export const MAIN_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    type: 'function',
    name: 'exec_command',
    description:
      'Start a shell command in the current workspace and wait briefly for output. Fast commands behave like a one-shot shell call; long-running commands return a processId that you can continue with write_stdin. Use this for targeted shell probes, builds/tests, and short-lived local process checks. A small inline probe may include one short-lived local process started here and briefly observed with write_stdin. If answering the question requires repeated polling, multiple process lifecycles, concurrency orchestration, restart simulation, or a secret-backed or external observation loop that could materially change the implementation, open a question first and prefer spawn_experiment for the residual uncertainty.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        yieldTimeMs: { type: 'number' },
        maxOutputChars: { type: 'number' }
      },
      required: ['command'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'write_stdin',
    description:
      'Send stdin to a running exec_command process, poll for more output, close stdin, or terminate the process. Leave input empty to poll only. Use this to briefly observe a short-lived local process, send input, close stdin, or terminate it. If the same claim needs repeated polling or multiple process lifecycles, that is no longer a small inline probe and should usually move to an open question plus spawn_experiment.',
    parameters: {
      type: 'object',
      properties: {
        processId: { type: 'number' },
        input: { type: 'string' },
        yieldTimeMs: { type: 'number' },
        maxOutputChars: { type: 'number' },
        closeStdin: { type: 'boolean' },
        terminate: { type: 'boolean' }
      },
      required: ['processId'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'read',
    description:
      'Read a specific file from the workspace. By default, returns the first 100 lines. Use startLine and endLine for targeted slices when you need a different range; avoid broad file dumping when a smaller read would do.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'number' },
        endLine: { type: 'number' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'ls',
    description: 'List a directory in the workspace. Use this for quick orientation before broader globbing or searching.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'edit',
    description:
      'Apply file changes with the explicit patch grammar. Use this for normal workspace file creation, updates, moves, and deletions. The patch must start with "*** Begin Patch" and end with "*** End Patch". Use "*** Add File: path", "*** Update File: path", or "*** Delete File: path"; updates may include "*** Move to: new/path" and one or more "@@" hunks with context lines prefixed by space, removals by "-", and additions by "+". Prefer small, exact hunks. Do not use shell heredocs or ad hoc string replacement for normal file edits, and do not edit through a still-open load-bearing question.',
    parameters: {
      type: 'object',
      properties: {
        patch: { type: 'string' }
      },
      required: ['patch'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'glob',
    description:
      'Find files using a glob pattern. Keep patterns narrow and purposeful; avoid broad scans of generated output, dependency directories, or node_modules unless they are directly relevant.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' }
      },
      required: ['pattern'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'rg',
    description:
      'Search files for a text pattern. Prefer targeted paths or symbols over repo-wide fishing, and avoid searching dependency trees unless the question specifically depends on them.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        target: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
        }
      },
      required: ['pattern'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'spawn_experiment',
    description:
      'Run a bounded experiment in an isolated copy of the current workspace to answer one residual uncertainty for an open question. Use this after a focused local evidence pass when the unresolved claim still matters and a disposable study is the cheapest reliable way to decide it. questionId is required. hypothesis should be falsifiable. residualUncertainty should name the single remaining unknown this experiment must decide. The harness will derive the local evidence summary from the current question and recent evidence, so do not restate it unless extra context is materially necessary. Do not use this for vague exploration, repeated repo inspection, or to restate the full implementation plan. Prefer one experiment per question; parallel experiments only for orthogonal risks. Once this is the chosen evidence path for a question, prefer wait_experiment or read_experiment over duplicate inline probing. This is a good fit for live external or secret-backed probes when independent safe work can continue in parallel. If you do not have a strong reason to choose smaller, use a 50000 token budget.',
    parameters: {
      type: 'object',
      properties: {
        questionId: { type: 'string' },
        hypothesis: { type: 'string' },
        residualUncertainty: { type: 'string' },
        context: { type: 'string' },
        budgetTokens: { type: 'number' },
        preserve: { type: 'boolean' }
      },
      required: ['questionId', 'hypothesis', 'residualUncertainty'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'extend_experiment_budget',
    description: 'Add more estimated tokens to a paused or running experiment budget.',
    parameters: {
      type: 'object',
      properties: {
        experimentId: { type: 'string' },
        additionalTokens: { type: 'number' }
      },
      required: ['experimentId', 'additionalTokens'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'read_experiment',
    description:
      'Read the full durable record for a previously spawned experiment, including observations and final details. Prefer wait_experiment for routine live checks while an experiment is still running.',
    parameters: {
      type: 'object',
      properties: {
        experimentId: { type: 'string' }
      },
      required: ['experimentId'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'wait_experiment',
    description:
      'Wait for a running experiment to resolve, up to a bounded timeout in milliseconds. This is the default follow-up after spawning when the experiment is the main evidence source. If timeoutMs is omitted, a longer default wait is used; very short waits are rounded up.',
    parameters: {
      type: 'object',
      properties: {
        experimentId: { type: 'string' },
        timeoutMs: { type: 'number' }
      },
      required: ['experimentId'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'search_experiments',
    description:
      'Search prior experiment history for evidence relevant to the current named question. This is never the first step on a new task and never freeform memory lookup. Use it only when a live question already exists or you are explicitly resuming a previously opened question. Query for the claim, not the broad topic. Treat hits as candidate evidence only; read the specific experiment before relying on it.',
    parameters: {
      type: 'object',
      properties: {
        questionId: { type: 'string' },
        query: { type: 'string' }
      },
      required: ['questionId'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'narrow_question',
    description:
      'Close an open question as scope_narrowed and immediately open its narrower successor in one step. Use this when the original claim was too broad or an experiment invalidated the current path and you need a different successor claim before dependent edits can proceed. summary and whyItMatters should describe the successor claim, not the old one. affectedPaths is required and should scope only the edits that depend on the successor claim. evidencePaths is optional and only for same-question probe ownership on the successor claim. note should state why the original question is no longer the right blocker and what changed.',
    parameters: {
      type: 'object',
      properties: {
        questionId: { type: 'string' },
        summary: { type: 'string' },
        whyItMatters: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['runtime', 'scope', 'architecture']
        },
        affectedPaths: {
          type: 'array',
          items: { type: 'string' }
        },
        evidencePaths: {
          type: 'array',
          items: { type: 'string' }
        },
        recommendedStudy: { type: 'string' },
        note: { type: 'string' }
      },
      required: ['questionId', 'summary', 'whyItMatters', 'affectedPaths', 'note'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'open_question',
    description:
      'Declare a load-bearing unresolved claim that blocks dependent edits. Use this when being wrong could materially change architecture, interfaces, protocol behavior, recovery, durability, retry, ownership, history, or integration behavior. summary should name the concrete claim. whyItMatters should say what would change if the answer goes the other way. In greenfield work, do not open a question merely because several designs exist; open one only when the prompt leaves a product contract underdetermined. If the unresolved choice is a product contract about history, recovery, retry, durability, or ownership semantics, use open_question instead of only stating a commitment note. Keep questions narrow; if one umbrella question would gate most of the feature, split or narrow it before spawning. affectedPaths is required and should list only the specific files or directories whose edits depend on the claim, not the whole feature area, and may not be the repo root. evidencePaths is optional; use it only when a linked experiment should own same-question inline probing on specific paths. evidencePaths should never be broader than needed and may not be the repo root or wildcard root scopes like . or *. If you omit evidencePaths, the question still gates dependent edits but it does not get implicit probe ownership. Do not spend a question on routine implementation taste or on a capability check that one focused read or tiny local probe can settle immediately unless that check is the true blocker. Open the question before any live external, secret-backed, or runtime probe that could change the implementation.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        whyItMatters: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['runtime', 'scope', 'architecture']
        },
        affectedPaths: {
          type: 'array',
          items: { type: 'string' }
        },
        evidencePaths: {
          type: 'array',
          items: { type: 'string' }
        },
        recommendedStudy: { type: 'string' }
      },
      required: ['summary', 'whyItMatters', 'affectedPaths'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'resolve_question',
    description:
      'Resolve a previously opened question once dependent edits are safe again. Use study_run when an experiment or other study answered it; static_evidence_sufficient when a focused local pass settled it; scope_narrowed when you explicitly reduced the claim or implementation scope so blocked edits no longer depend on the original question; user_override when the user explicitly chose the answer. note should record the answer or narrowing, the evidence that justified it, and why dependent edits are now allowed. Do not resolve with vague optimism.',
    parameters: {
      type: 'object',
      properties: {
        questionId: { type: 'string' },
        resolution: {
          type: 'string',
          enum: ['study_run', 'static_evidence_sufficient', 'scope_narrowed', 'user_override']
        },
        note: { type: 'string' }
      },
      required: ['questionId', 'resolution', 'note'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'compact',
    description:
      'Checkpoint current state before context compression. goal should restate the current objective, completed should capture durable progress, next should name the next concrete step after compaction, openRisks may note unresolved risks, currentCommitments may preserve the active product or implementation contract the work now depends on, and importantNonGoals may preserve the deliberate scope exclusions that still matter for consistency.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        completed: { type: 'string' },
        next: { type: 'string' },
        openRisks: { type: 'string' },
        currentCommitments: { type: 'string' },
        importantNonGoals: { type: 'string' }
      },
      required: ['goal', 'completed', 'next'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'create_plan',
    description:
      'Create or update a concise reviewable plan artifact for this session during the plan-mode planning phase. Capture the concrete implementation path, assumptions, files, steps, validation, and risks. Use ask_user only if the user must choose between materially different options.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        assumptions: {
          type: 'array',
          items: { type: 'string' }
        },
        files: {
          type: 'array',
          items: { type: 'string' }
        },
        steps: {
          type: 'array',
          items: { type: 'string' }
        },
        validation: {
          type: 'array',
          items: { type: 'string' }
        },
        risks: {
          type: 'array',
          items: { type: 'string' }
        },
        planMarkdown: { type: 'string' }
      },
      required: [
        'goal',
        'assumptions',
        'files',
        'steps',
        'validation',
        'risks',
        'planMarkdown'
      ],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'ask_user',
    description:
      'Pause for user input in plan mode. Use this for a real clarification question or a material user choice the model cannot safely decide alone. For single_choice requests, present 2 to 4 options and set exactly one recommendedOptionId. For yes_no or single_choice requests, include a reason so the harness or user can evaluate the recommendation directly.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['clarification', 'approval']
        },
        responseKind: {
          type: 'string',
          enum: ['open', 'yes_no', 'single_choice']
        },
        question: { type: 'string' },
        context: { type: 'string' },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              description: { type: 'string' }
            },
            required: ['id', 'label', 'description'],
            additionalProperties: false
          }
        },
        recommendedOptionId: { type: 'string' },
        recommendedResponse: {
          type: 'string',
          enum: ['yes', 'no']
        },
        reason: { type: 'string' }
      },
      required: ['kind', 'responseKind', 'question'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'update_todos',
    description:
      'Replace the local execution todo list for this session. Use only for implementation and validation tracking, not for product semantics, unresolved questions, or experiment findings.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'done']
              }
            },
            required: ['id', 'text', 'status'],
            additionalProperties: false
          }
        }
      },
      required: ['items'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'resolve_experiment',
    description:
      'Resolve an experiment with a final verdict, summary, and any important findings, artifacts, constraints, or confidence notes.',
    parameters: {
      type: 'object',
      properties: {
        experimentId: { type: 'string' },
        verdict: {
          type: 'string',
          enum: ['validated', 'invalidated', 'inconclusive']
        },
        summary: { type: 'string' },
        discovered: {
          type: 'array',
          items: { type: 'string' }
        },
        artifacts: {
          type: 'array',
          items: { type: 'string' }
        },
        constraints: {
          type: 'array',
          items: { type: 'string' }
        },
        confidenceNote: { type: 'string' },
        resolutionNote: { type: 'string' },
        promote: { type: 'boolean' }
      },
      required: ['experimentId', 'verdict', 'summary'],
      additionalProperties: false
    }
  }
];

function requireToolDefinition(name: string): ToolDefinition {
  const definition = MAIN_TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
  if (!definition) {
    throw new Error(`Missing tool definition for ${name}.`);
  }
  return definition;
}

function filterToolDefinitions(names: readonly string[]): readonly ToolDefinition[] {
  return names.map((name) => requireToolDefinition(name));
}

export const STUDY_TOOL_DEFINITIONS = MAIN_TOOL_DEFINITIONS.filter(
  (definition) =>
    definition.name !== 'create_plan' &&
    definition.name !== 'ask_user' &&
    definition.name !== 'update_todos'
);

export const PLAN_PLANNING_TOOL_DEFINITIONS = filterToolDefinitions([
  'exec_command',
  'write_stdin',
  'read',
  'ls',
  'glob',
  'rg',
  'create_plan',
  'ask_user'
]);

export const PLAN_EXECUTION_TOOL_DEFINITIONS = filterToolDefinitions([
  'exec_command',
  'write_stdin',
  'read',
  'ls',
  'edit',
  'glob',
  'rg',
  'ask_user',
  'update_todos'
]);

export const DIRECT_TOOL_DEFINITIONS = filterToolDefinitions([
  'exec_command',
  'write_stdin',
  'read',
  'ls',
  'edit',
  'glob',
  'rg',
  'update_todos'
]);

export const EXPERIMENT_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  MAIN_TOOL_DEFINITIONS.find((definition) => definition.name === 'exec_command')!,
  MAIN_TOOL_DEFINITIONS.find((definition) => definition.name === 'write_stdin')!,
  MAIN_TOOL_DEFINITIONS.find((definition) => definition.name === 'read')!,
  MAIN_TOOL_DEFINITIONS.find((definition) => definition.name === 'ls')!,
  MAIN_TOOL_DEFINITIONS.find((definition) => definition.name === 'edit')!,
  MAIN_TOOL_DEFINITIONS.find((definition) => definition.name === 'glob')!,
  MAIN_TOOL_DEFINITIONS.find((definition) => definition.name === 'rg')!,
  {
    type: 'function',
    name: 'log_observation',
    description: 'Append a timestamped observation to the current experiment.',
    parameters: {
      type: 'object',
      properties: {
        experimentId: { type: 'string' },
        message: { type: 'string' },
        tags: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['promising', 'discovery', 'blocker', 'question', 'conclusion']
          }
        }
      },
      required: ['experimentId', 'message'],
      additionalProperties: false
    }
  },
  MAIN_TOOL_DEFINITIONS.find((definition) => definition.name === 'read_experiment')!,
  {
    type: 'function',
    name: 'resolve_experiment',
    description:
      'Resolve the current experiment with a verdict, summary, and any important findings, artifacts, constraints, or confidence notes.',
    parameters: {
      type: 'object',
      properties: {
        experimentId: { type: 'string' },
        verdict: {
          type: 'string',
          enum: ['validated', 'invalidated', 'inconclusive']
        },
        summary: { type: 'string' },
        discovered: {
          type: 'array',
          items: { type: 'string' }
        },
        artifacts: {
          type: 'array',
          items: { type: 'string' }
        },
        constraints: {
          type: 'array',
          items: { type: 'string' }
        },
        confidenceNote: { type: 'string' },
        resolutionNote: { type: 'string' },
        promote: { type: 'boolean' }
      },
      required: ['experimentId', 'verdict', 'summary'],
      additionalProperties: false
    }
  }
];

function readOptionalOutputSummary(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const maybeObject = value as Record<string, unknown>;
  return typeof maybeObject.summary === 'string' ? maybeObject.summary : null;
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function summarizePatchForHeader(patch: string): string {
  const operations = extractPatchOperationSummaries(patch);
  if (operations.length === 0) {
    return 'Edit(patch)';
  }
  return `Edit(${compactTextForHeader(operations.join(', '), 64)})`;
}

function summarizePatchForBody(patch: string): string[] {
  const operations = extractPatchOperationSummaries(patch);
  if (operations.length === 0) {
    return ['patch: custom diff'];
  }
  return operations.map((operation) => `patch: ${operation}`);
}

function extractPatchOperationSummaries(patch: string): string[] {
  const lines = patch.split(/\r?\n/);
  const operations: string[] = [];

  for (const line of lines) {
    if (line.startsWith('*** Add File: ')) {
      operations.push(`add ${line.slice('*** Add File: '.length).trim()}`);
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      operations.push(`update ${line.slice('*** Update File: '.length).trim()}`);
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      operations.push(`delete ${line.slice('*** Delete File: '.length).trim()}`);
    }
  }

  return operations;
}

function formatJsonArgumentPreview(args: Record<string, unknown>): string[] {
  if (Object.keys(args).length === 0) {
    return [];
  }

  const pretty = JSON.stringify(args, null, 2);
  if (!pretty) {
    return [];
  }

  const lines = pretty.split('\n');
  if (lines.length <= 4) {
    return lines;
  }

  return [...lines.slice(0, 4), `… ${lines.length - 4} more line(s)`];
}

function compactTextForHeader(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function formatReadHeader(path: string, startLine?: number, endLine?: number): string {
  if (typeof startLine === 'number' && typeof endLine === 'number') {
    return `Read(${path}:${Math.floor(startLine)}-${Math.floor(endLine)})`;
  }

  if (typeof startLine === 'number') {
    return `Read(${path}:${Math.floor(startLine)}-)`;
  }

  if (typeof endLine === 'number') {
    return `Read(${path}:1-${Math.floor(endLine)})`;
  }

  return `Read(${path})`;
}

async function executeToolCall(call: ToolCall, tools: AgentTools): Promise<string> {
  const args = parseArguments(call.rawArguments);

  switch (call.name) {
    case 'exec_command':
      return tools.execCommand({
        command: readStringArg(args, 'command'),
        cwd: readOptionalStringArg(args, 'cwd'),
        yieldTimeMs: readOptionalNumberArg(args, 'yieldTimeMs'),
        maxOutputChars: readOptionalNumberArg(args, 'maxOutputChars')
      });
    case 'write_stdin':
      return tools.writeStdin({
        processId: readNumberArg(args, 'processId'),
        input: readOptionalStringArg(args, 'input'),
        yieldTimeMs: readOptionalNumberArg(args, 'yieldTimeMs'),
        maxOutputChars: readOptionalNumberArg(args, 'maxOutputChars'),
        closeStdin: readOptionalBooleanArg(args, 'closeStdin'),
        terminate: readOptionalBooleanArg(args, 'terminate')
      });
    case 'read':
      return tools.read(
        readStringArg(args, 'path'),
        readOptionalNumberArg(args, 'startLine'),
        readOptionalNumberArg(args, 'endLine')
      );
    case 'ls':
      if (!tools.ls) {
        throw new Error('ls is not available in this session.');
      }
      return tools.ls(
        readOptionalStringArg(args, 'path'),
        readOptionalBooleanArg(args, 'recursive')
      );
    case 'write':
      if (!tools.write) {
        throw new Error('write is not available in this session.');
      }
      return tools.write(readStringArg(args, 'path'), readStringArg(args, 'content'));
    case 'edit':
      return tools.edit(readStringArg(args, 'patch'));
    case 'glob':
      return JSON.stringify(await tools.glob(readStringArg(args, 'pattern')), null, 2);
    case 'rg':
      if (!tools.rg) {
        throw new Error('rg is not available in this session.');
      }
      return tools.rg(readStringArg(args, 'pattern'), readOptionalStringOrArrayArg(args, 'target'));
    case 'grep':
      if (tools.grep) {
        return tools.grep(
          readStringArg(args, 'pattern'),
          readOptionalStringOrArrayArg(args, 'target')
        );
      }
      if (!tools.rg) {
        throw new Error('rg is not available in this session.');
      }
      return tools.rg(readStringArg(args, 'pattern'), readOptionalStringOrArrayArg(args, 'target'));
    case 'spawn_experiment': {
      const experiment = await tools.spawnExperiment({
        studyDebtId:
          readOptionalStringArg(args, 'questionId') ?? readOptionalStringArg(args, 'studyDebtId'),
        hypothesis: readStringArg(args, 'hypothesis'),
        localEvidenceSummary: readOptionalStringArg(args, 'localEvidenceSummary'),
        residualUncertainty: readStringArg(args, 'residualUncertainty'),
        context: readOptionalStringArg(args, 'context'),
        budgetTokens:
          readOptionalNumberArg(args, 'budgetTokens') ?? DEFAULT_EXPERIMENT_BUDGET_TOKENS,
        preserve: readOptionalBooleanArg(args, 'preserve') ?? false
      });
      return JSON.stringify(serializeExperimentForModel(experiment), null, 2);
    }
    case 'narrow_question':
      if (!tools.narrowStudyDebt) {
        throw new Error('narrow_question is not available in this session.');
      }
      return JSON.stringify(
        await tools.narrowStudyDebt({
          questionId: readStringArg(args, 'questionId'),
          summary: readStringArg(args, 'summary'),
          whyItMatters: readStringArg(args, 'whyItMatters'),
          kind: readOptionalStringArg(args, 'kind') as StudyDebtKind | undefined,
          affectedPaths: readStringArrayArg(args, 'affectedPaths'),
          evidencePaths: readOptionalStringArrayArg(args, 'evidencePaths'),
          recommendedStudy: readOptionalStringArg(args, 'recommendedStudy'),
          note: readStringArg(args, 'note')
        }),
        null,
        2
      );
    case 'extend_experiment_budget':
      if (!tools.extendExperimentBudget) {
        throw new Error('extend_experiment_budget is not available in this session.');
      }
      return JSON.stringify(
        await tools.extendExperimentBudget(
          readStringArg(args, 'experimentId'),
          readOptionalNumberArg(args, 'additionalTokens') ?? 0
        ),
        null,
        2
      );
    case 'read_experiment':
      return JSON.stringify(
        serializeExperimentForModel(await tools.readExperiment(readStringArg(args, 'experimentId'))),
        null,
        2
      );
    case 'wait_experiment':
      if (!tools.waitExperiment) {
        throw new Error('wait_experiment is not available in this session.');
      }
      return JSON.stringify(
        await tools.waitExperiment(
          readStringArg(args, 'experimentId'),
          normalizeExperimentWaitTimeout(readOptionalNumberArg(args, 'timeoutMs'))
        ),
        null,
        2
      );
    case 'search_experiments':
      if (!tools.searchExperiments) {
        throw new Error('search_experiments is not available in this session.');
      }
      return JSON.stringify(
        await tools.searchExperiments(
          readStringArg(args, 'questionId'),
          readOptionalStringArg(args, 'query')
        ),
        null,
        2
      );
    case 'create_plan':
      if (!tools.createPlan) {
        throw new Error('create_plan is not available in this session.');
      }
      return JSON.stringify(
        await tools.createPlan({
          goal: readStringArg(args, 'goal'),
          assumptions: readStringArrayArg(args, 'assumptions'),
          files: readStringArrayArg(args, 'files'),
          steps: readStringArrayArg(args, 'steps'),
          validation: readStringArrayArg(args, 'validation'),
          risks: readStringArrayArg(args, 'risks'),
          planMarkdown: readStringArg(args, 'planMarkdown')
        }),
        null,
        2
      );
    case 'ask_user':
      if (!tools.askUser) {
        throw new Error('ask_user is not available in this session.');
      }
      return JSON.stringify(
        await tools.askUser({
          kind: readStringArg(args, 'kind') as 'clarification' | 'approval',
          responseKind: readStringArg(args, 'responseKind') as 'open' | 'yes_no' | 'single_choice',
          question: readStringArg(args, 'question'),
          context: readOptionalStringArg(args, 'context'),
          options: readOptionalAskUserOptionsArg(args, 'options'),
          recommendedOptionId: readOptionalStringArg(args, 'recommendedOptionId'),
          recommendedResponse: readOptionalStringArg(args, 'recommendedResponse') as
            | 'yes'
            | 'no'
            | undefined,
          reason: readOptionalStringArg(args, 'reason')
        }),
        null,
        2
      );
    case 'update_todos':
      if (!tools.updateTodos) {
        throw new Error('update_todos is not available in this session.');
      }
      return JSON.stringify(
        await tools.updateTodos({
          items: readTodoItemsArg(args, 'items')
        }),
        null,
        2
      );
    case 'open_question':
    case 'open_study_debt':
      if (!tools.openStudyDebt) {
        throw new Error('open_question is not available in this session.');
      }
      return JSON.stringify(
        await tools.openStudyDebt({
          summary: readStringArg(args, 'summary'),
          whyItMatters: readStringArg(args, 'whyItMatters'),
          kind: readOptionalStringArg(args, 'kind') as StudyDebtKind | undefined,
          affectedPaths: readStringArrayArg(args, 'affectedPaths'),
          evidencePaths: readOptionalStringArrayArg(args, 'evidencePaths'),
          recommendedStudy: readOptionalStringArg(args, 'recommendedStudy')
        }),
        null,
        2
      );
    case 'resolve_question':
    case 'resolve_study_debt':
      if (!tools.resolveStudyDebt) {
        throw new Error('resolve_question is not available in this session.');
      }
      return JSON.stringify(
        await tools.resolveStudyDebt({
          questionId:
            readOptionalStringArg(args, 'questionId') ?? readStringArg(args, 'debtId'),
          resolution: readStringArg(args, 'resolution') as StudyDebtResolution,
          note: readStringArg(args, 'note')
        }),
        null,
        2
      );
    case 'compact':
      if (!tools.compact) {
        throw new Error('compact is not available in this session.');
      }
      return JSON.stringify(
        await tools.compact(
          readStringArg(args, 'goal'),
          readStringArg(args, 'completed'),
          readStringArg(args, 'next'),
          readOptionalStringArg(args, 'openRisks'),
          readOptionalStringArg(args, 'currentCommitments'),
          readOptionalStringArg(args, 'importantNonGoals')
        ),
        null,
        2
      );
    case 'log_observation':
      if (!tools.logObservation) {
        throw new Error('log_observation is not available in this session.');
      }
      return JSON.stringify(
        await tools.logObservation(
          readStringArg(args, 'experimentId'),
          readStringArg(args, 'message'),
          readOptionalStringArrayArg(args, 'tags') as ExperimentObservationTag[] | undefined
        ),
        null,
        2
      );
    case 'resolve_experiment':
      if (!tools.resolveExperiment) {
        throw new Error('resolve_experiment is not available in this session.');
      }
      return JSON.stringify(
        await tools.resolveExperiment({
          experimentId: readStringArg(args, 'experimentId'),
          verdict: readStringArg(args, 'verdict') as
            | 'validated'
            | 'invalidated'
            | 'inconclusive',
          summary: readStringArg(args, 'summary'),
          discovered: readOptionalStringArrayArg(args, 'discovered') ?? [],
          artifacts: readOptionalStringArrayArg(args, 'artifacts') ?? [],
          constraints: readOptionalStringArrayArg(args, 'constraints') ?? [],
          confidenceNote: readOptionalStringArg(args, 'confidenceNote'),
          resolutionNote: readOptionalStringArg(args, 'resolutionNote'),
          promote: readOptionalBooleanArg(args, 'promote') ?? false
        }),
        null,
        2
      );
    default:
      throw new Error(`Unknown model tool: ${call.name}`);
  }
}

async function executeToolCallSafely(
  call: ToolCall,
  tools: AgentTools
): Promise<{ output: string; failed: boolean }> {
  try {
    return {
      output: await executeToolCall(call, tools),
      failed: false
    };
  } catch (error) {
    if (error instanceof ExperimentBudgetExceededError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      output: JSON.stringify(
        {
          ok: false,
          error: {
            tool: call.name,
            message
          }
        },
        null,
        2
      ),
      failed: true
    };
  }
}

export function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Tool arguments must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid tool arguments: ${message}`);
  }
}

function readStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing string argument: ${key}`);
  }
  return value;
}

function readOptionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOptionalArrayArg(args: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = args[key];
  return Array.isArray(value) ? value : undefined;
}

function readOptionalStringOrArrayArg(
  args: Record<string, unknown>,
  key: string
): string | string[] | undefined {
  const stringValue = readOptionalStringArg(args, key);
  if (stringValue !== undefined) {
    return stringValue;
  }
  return readOptionalStringArrayArg(args, key);
}

function readOptionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readNumberArg(args: Record<string, unknown>, key: string): number {
  const value = readOptionalNumberArg(args, key);
  if (value === undefined) {
    throw new Error(`Missing number argument: ${key}`);
  }
  return value;
}

function readOptionalBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readOptionalStringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  const filtered = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return filtered.length > 0 ? filtered : [];
}

function readStringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value as string[];
}

function readOptionalAskUserOptionsArg(
  args: Record<string, unknown>,
  key: string
): Array<{ id: string; label: string; description: string }> | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array.`);
  }

  return value.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`${key} entries must be objects.`);
    }
    const option = item as Record<string, unknown>;
    if (
      typeof option.id !== 'string' ||
      typeof option.label !== 'string' ||
      typeof option.description !== 'string'
    ) {
      throw new Error(`${key} entries must include id, label, and description.`);
    }
    return {
      id: option.id,
      label: option.label,
      description: option.description
    };
  });
}


function readTodoItemsArg(
  args: Record<string, unknown>,
  key: string
): Array<{ id: string; text: string; status: 'pending' | 'in_progress' | 'done' }> {
  const value = args[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array.`);
  }

  return value.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`${key} entries must be objects.`);
    }

    const todo = item as Record<string, unknown>;
    const id = todo.id;
    const text = todo.text;
    const status = todo.status;
    if (
      typeof id !== 'string' ||
      typeof text !== 'string' ||
      (status !== 'pending' && status !== 'in_progress' && status !== 'done')
    ) {
      throw new Error(`${key} entries must include id, text, and a valid status.`);
    }
    return { id, text, status };
  });
}
