import type { ModelHistoryItem } from '../types.js';
import type { ToolDefinition } from './codex-tooling.js';

export function shouldInjectExperimentHint(
  inputText: string,
  requestItems: ModelHistoryItem[],
  toolDefinitions: readonly ToolDefinition[]
): boolean {
  if (!toolDefinitions.some((tool) => tool.name === 'spawn_experiment')) {
    return false;
  }

  const functionCalls = getCurrentTurnFunctionCalls(requestItems);
  const inlineProbeCalls = getInlineProbeCalls(functionCalls);
  if (inlineProbeCalls.length < 6) {
    return false;
  }

  if (functionCalls.some((item) => item.name === 'spawn_experiment')) {
    return false;
  }

  if (functionCalls.some((item) => ['write', 'edit'].includes(item.name))) {
    return false;
  }

  return appearsStudyableByExperiment(inputText, inlineProbeCalls) && isCirclingRiskArea(inlineProbeCalls);
}

export function shouldInjectEarlyStudyOpportunityHint(
  inputText: string,
  requestItems: ModelHistoryItem[],
  toolDefinitions: readonly ToolDefinition[]
): boolean {
  if (!toolDefinitions.some((tool) => tool.name === 'spawn_experiment')) {
    return false;
  }

  const functionCalls = getCurrentTurnFunctionCalls(requestItems);
  if (functionCalls.some((item) => item.name === 'spawn_experiment')) {
    return false;
  }

  if (functionCalls.some((item) => ['write', 'edit'].includes(item.name))) {
    return false;
  }

  if (functionCalls.some((item) => ['open_question', 'open_study_debt'].includes(item.name))) {
    return false;
  }

  const inlineProbeCalls = getInlineProbeCalls(functionCalls);
  if (inlineProbeCalls.length < 4) {
    return false;
  }

  if (!appearsStudyableByExperiment(inputText, inlineProbeCalls)) {
    return false;
  }

  return inlineProbeCalls.length >= 5 || isCirclingRiskArea(inlineProbeCalls);
}

export function shouldInjectPreEditGuardHint(requestItems: ModelHistoryItem[]): boolean {
  const functionCalls = getCurrentTurnFunctionCalls(requestItems);
  const currentTurnItems = getCurrentTurnItems(requestItems);

  const lastCall = functionCalls.at(-1);
  if (!lastCall || !['write', 'edit'].includes(lastCall.name)) {
    return false;
  }

  if (functionCalls.some((item) => item.name === 'spawn_experiment')) {
    return false;
  }

  if (functionCalls.some((item) => ['open_question', 'open_study_debt'].includes(item.name))) {
    return false;
  }

  if (functionCalls.some((item) => ['resolve_question', 'resolve_study_debt'].includes(item.name))) {
    return false;
  }

  const usedProviderWebSearch = currentTurnItems.some(
    (item) =>
      item.type === 'message' &&
      item.role === 'developer' &&
      item.content.startsWith('Built-in web_search executed.')
  );

  const investigationCalls = getInlineProbeCalls(functionCalls.slice(0, -1));

  if (usedProviderWebSearch) {
    return true;
  }

  return investigationCalls.length >= 5 && isCirclingRiskArea(investigationCalls);
}

export function shouldInjectPostSpawnWaitHint(requestItems: ModelHistoryItem[]): boolean {
  const functionCalls = getCurrentTurnFunctionCalls(requestItems);
  const lastSpawnIndex = functionCalls.map((item) => item.name).lastIndexOf('spawn_experiment');
  if (lastSpawnIndex === -1) {
    return false;
  }

  const afterSpawn = functionCalls.slice(lastSpawnIndex + 1);
  if (afterSpawn.some((item) => item.name === 'wait_experiment')) {
    return false;
  }

  const repeatedInlineProbing = afterSpawn.filter((item) =>
    ['bash', 'read', 'ls', 'glob', 'rg', 'grep'].includes(item.name)
  ).length;

  return repeatedInlineProbing >= 3;
}

export function shouldInjectObservationHint(
  requestItems: ModelHistoryItem[],
  toolDefinitions: readonly ToolDefinition[]
): boolean {
  if (!toolDefinitions.some((tool) => tool.name === 'log_observation')) {
    return false;
  }

  const functionCalls = getCurrentTurnFunctionCalls(requestItems);
  const lastObservationIndex = functionCalls.map((item) => item.name).lastIndexOf('log_observation');
  const sinceLastObservation =
    lastObservationIndex === -1 ? functionCalls : functionCalls.slice(lastObservationIndex + 1);

  if (sinceLastObservation.some((item) => item.name === 'resolve_experiment')) {
    return false;
  }

  const substantiveToolCalls = sinceLastObservation.filter(
    (item) => !['log_observation', 'read_experiment'].includes(item.name)
  ).length;

  return substantiveToolCalls >= 4;
}

export function buildEarlyStudyOpportunityHint(): string {
  return [
    'Harness hint:',
    'You likely have enough context to launch one bounded study now.',
    'If this uncertainty could change the implementation choice and there is known-safe work you can continue in parallel, spawn the study early instead of waiting until you are blocked.',
    'If there are two distinct unresolved claims, separate them instead of forcing one study to do everything.',
    'Keep the study narrow, concrete, and falsifiable.'
  ].join(' ');
}

export function buildExperimentHint(): string {
  return [
    'Harness hint:',
    'You are still circling a studyable uncertainty inline without yet launching a bounded study.',
    'If spawn_experiment can settle this more cheaply than more background probing, run one narrow study now.',
    'Prefer a concrete falsifier over more read/rg churn, and separate distinct hypotheses instead of collapsing them into one vague study.'
  ].join(' ');
}

export function buildPreEditGuardHint(): string {
  return [
    'Harness hint:',
    'You investigated this plan for a while and are now moving toward implementation.',
    'If external docs or web search materially shaped the protocol, backend, provider, or runtime path, track that as a current question before editing through it.',
    'If dependent edits still rely on unresolved load-bearing uncertainty, declare or resolve an open question before editing through it.',
    'Either open a question, justify why static evidence is sufficient, or explicitly narrow scope before editing dependent code.'
  ].join(' ');
}

export function buildPostSpawnWaitHint(): string {
  return [
    'Harness hint:',
    'You already have a live experiment on this hypothesis.',
    'If this experiment is the main evidence source for the current question, wait for it to resolve before editing on that same question.',
    'Prefer wait_experiment or one small external-observer corroboration check over continued background reading or probing about the same question.',
    'Use read_experiment only if you need the full durable record rather than a lightweight live status check.'
  ].join(' ');
}

export function buildObservationHint(): string {
  return [
    'Harness hint:',
    'You have made several tool calls in this experiment without logging a fresh observation.',
    'Record a concrete finding, blocker, changed belief, or current dead-end now.',
    'Do not log routine activity; log the evidence or obstacle that actually matters.'
  ].join(' ');
}

function getCurrentTurnItems(requestItems: ModelHistoryItem[]): ModelHistoryItem[] {
  for (let index = requestItems.length - 1; index >= 0; index -= 1) {
    const item = requestItems[index];
    if (item?.type === 'message' && item.role === 'user') {
      return requestItems.slice(index + 1);
    }
  }

  return requestItems;
}

function getCurrentTurnFunctionCalls(
  requestItems: ModelHistoryItem[]
): Array<Extract<ModelHistoryItem, { type: 'function_call' }>> {
  return getCurrentTurnItems(requestItems).filter(
    (item): item is Extract<ModelHistoryItem, { type: 'function_call' }> => item.type === 'function_call'
  );
}

function getInlineProbeCalls(
  functionCalls: Array<Extract<ModelHistoryItem, { type: 'function_call' }>>
): Array<Extract<ModelHistoryItem, { type: 'function_call' }>> {
  return functionCalls.filter((item) => ['bash', 'read', 'ls', 'glob', 'rg', 'grep'].includes(item.name));
}

function appearsStudyableByExperiment(
  inputText: string,
  inlineProbeCalls: Array<Extract<ModelHistoryItem, { type: 'function_call' }>>
): boolean {
  const combinedSignals = [
    inputText,
    ...inlineProbeCalls.map((item) => getStudySignalText(item))
  ].join('\n');

  const strongLifecycleOnly =
    /(process death|main process dies|kill the harness|restart the harness|app shutdown|startup reconciliation|rehydrat|supervisor)/i.test(
      combinedSignals
    );
  if (strongLifecycleOnly) {
    return false;
  }

  return hasRiskSignal(combinedSignals);
}

function isCirclingRiskArea(
  inlineProbeCalls: Array<Extract<ModelHistoryItem, { type: 'function_call' }>>
): boolean {
  const focusCounts = new Map<string, number>();
  let riskySignalCount = 0;

  for (const call of inlineProbeCalls) {
    const signal = getStudySignalText(call);
    if (signal && hasRiskSignal(signal)) {
      riskySignalCount += 1;
    }

    const focusKey = getStudyFocusKey(call);
    if (!focusKey) {
      continue;
    }
    focusCounts.set(focusKey, (focusCounts.get(focusKey) ?? 0) + 1);
  }

  return riskySignalCount >= 3 || Array.from(focusCounts.values()).some((count) => count >= 2);
}

function hasRiskSignal(text: string): boolean {
  return /(auth|session|login|register|redirect|cookie|continu|ownership|migrat|transfer|persist|cache|invalidat|provider|fallback|stream|retry|integrat|dependency|compat|isolat|concurr|runtime|behavior|safely|without breaking|actually correct|state|uncertainty|evidence|repro|worktree|background|artifact|autosave|draft)/i.test(
    text
  );
}

function getStudySignalText(
  call: Extract<ModelHistoryItem, { type: 'function_call' }>
): string {
  const args = parseArguments(call.arguments);

  switch (call.name) {
    case 'read':
      return readOptionalStringArg(args, 'path') ?? '';
    case 'ls':
      return readOptionalStringArg(args, 'path') ?? '.';
    case 'rg':
    case 'grep':
      return [readOptionalStringArg(args, 'pattern'), readOptionalStringArg(args, 'target')]
        .filter(Boolean)
        .join(' ');
    case 'glob':
      return readOptionalStringArg(args, 'pattern') ?? '';
    case 'bash':
      return readOptionalStringArg(args, 'command') ?? '';
    default:
      return '';
  }
}

function getStudyFocusKey(
  call: Extract<ModelHistoryItem, { type: 'function_call' }>
): string | null {
  const args = parseArguments(call.arguments);

  if (call.name === 'read') {
    return normalizeFocusKey(readOptionalStringArg(args, 'path'));
  }

  if (call.name === 'ls') {
    return normalizeFocusKey(readOptionalStringArg(args, 'path'));
  }

  if (call.name === 'rg' || call.name === 'grep') {
    return normalizeFocusKey(readOptionalStringArg(args, 'target') ?? readOptionalStringArg(args, 'pattern'));
  }

  if (call.name === 'glob') {
    return normalizeFocusKey(readOptionalStringArg(args, 'pattern'));
  }

  if (call.name === 'bash') {
    const command = readOptionalStringArg(args, 'command');
    if (!command) {
      return null;
    }

    const match = command.match(
      /(playwright|curl|next|npm|pnpm|yarn|bun|vitest|jest|test|build|dev|auth|session|login|register|redirect|cookie|cache|stream|provider|retry)/i
    );
    return match ? match[1]!.toLowerCase() : null;
  }

  return null;
}

function normalizeFocusKey(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const cleaned = value.trim().replace(/\\/g, '/');
  if (!cleaned) {
    return null;
  }

  if (cleaned.includes('/')) {
    const segments = cleaned.split('/').filter(Boolean).slice(0, 2);
    return segments.length > 0 ? segments.join('/') : null;
  }

  return cleaned.toLowerCase();
}

function parseArguments(raw: string): Record<string, unknown> {
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

function readOptionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
