import path from 'node:path';
import type { EngineSnapshot, ExperimentRecord, TranscriptEntry } from '../types.js';
import type {
  ExperimentSummary,
  RenderBlock,
  State,
  StatePatch
} from './render-types.js';

type ToolTone = Extract<RenderBlock, { kind: 'tool' }>['tone'];

const INPUT_PLACEHOLDER = 'Send a prompt…';
const PENDING_INPUT_PLACEHOLDER = 'Reply to the pending question…';
const INTERRUPTION_FOLLOWUP = 'Conversation interrupted. What do you want to do next?';

export function buildState(snapshot: EngineSnapshot): State {
  return {
    sessionId: snapshot.session.id,
    cwd: snapshot.session.cwd,
    processingTurn: snapshot.processingTurn,
    queuedUserMessages: [...snapshot.queuedUserMessages],
    status: formatStatus(snapshot),
    thinkingEnabled: snapshot.thinkingEnabled,
    inputPlaceholder: snapshot.pendingUserRequest ? PENDING_INPUT_PLACEHOLDER : INPUT_PLACEHOLDER,
    blocks: buildBlocks(snapshot),
    experiments: snapshot.experiments.map(summarizeExperiment)
  };
}

export function diffState(
  previous: State,
  next: State
): StatePatch | null {
  const patch: StatePatch = {
    sessionId: next.sessionId,
    cwd: next.cwd
  };
  let changed = false;

  if (!statusEquals(previous.status, next.status)) {
    patch.status = next.status;
    changed = true;
  }

  if (previous.processingTurn !== next.processingTurn) {
    patch.processingTurn = next.processingTurn;
    changed = true;
  }

  if (!stringArrayEquals(previous.queuedUserMessages, next.queuedUserMessages)) {
    patch.queuedUserMessages = next.queuedUserMessages;
    changed = true;
  }

  if (previous.thinkingEnabled !== next.thinkingEnabled) {
    patch.thinkingEnabled = next.thinkingEnabled;
    changed = true;
  }

  if (previous.inputPlaceholder !== next.inputPlaceholder) {
    patch.inputPlaceholder = next.inputPlaceholder;
    changed = true;
  }

  if (!experimentListEquals(previous.experiments, next.experiments)) {
    patch.experiments = next.experiments;
    changed = true;
  }

  const blockPatch = diffBlocks(previous.blocks, next.blocks);
  if (blockPatch.upsertBlocks.length > 0) {
    patch.upsertBlocks = blockPatch.upsertBlocks;
    changed = true;
  }
  if (blockPatch.removeBlockIds.length > 0) {
    patch.removeBlockIds = blockPatch.removeBlockIds;
    changed = true;
  }
  if (blockPatch.blockOrder) {
    patch.blockOrder = blockPatch.blockOrder;
    changed = true;
  }

  return changed ? patch : null;
}

function buildBlocks(snapshot: EngineSnapshot): RenderBlock[] {
  const blocks = snapshot.transcript.flatMap((entry) =>
    transcriptEntryToBlocks(entry, snapshot.thinkingEnabled)
  );

  for (const event of snapshot.liveTurnEvents) {
    if (!event.live) {
      continue;
    }

    if (event.kind === 'assistant' || event.kind === 'thinking') {
      if (event.kind === 'thinking' && !snapshot.thinkingEnabled) {
        continue;
      }
      blocks.push({
        id: event.id,
        kind: event.kind,
        text: event.text,
        live: event.live
      });
      continue;
    }

    if (event.transcriptText) {
      continue;
    }

    blocks.push({
      id: event.id,
      kind: 'tool',
      tone: getToolTone(event.toolName ?? 'tool'),
      header: event.label ?? (event.toolName ?? 'tool'),
      body:
        event.body.length > 0
          ? [event.detail ?? (event.providerExecuted ? 'searching…' : 'running…'), ...event.body]
          : [event.detail ?? (event.providerExecuted ? 'searching…' : 'running…')],
      footer: [],
      live: event.live
    });
  }

  if (snapshot.pendingUserRequest) {
    blocks.push(pendingUserRequestToBlock(snapshot));
  }

  return blocks;
}

function diffBlocks(
  previous: RenderBlock[],
  next: RenderBlock[]
): { upsertBlocks: RenderBlock[]; removeBlockIds: string[]; blockOrder?: string[] } {
  const previousById = new Map(previous.map((block) => [block.id, block]));
  const nextById = new Map(next.map((block) => [block.id, block]));
  const upsertBlocks: RenderBlock[] = [];
  const removeBlockIds: string[] = [];

  for (const block of previous) {
    if (!nextById.has(block.id)) {
      removeBlockIds.push(block.id);
    }
  }

  for (const block of next) {
    const previousBlock = previousById.get(block.id);
    if (!previousBlock || !blockEquals(previousBlock, block)) {
      upsertBlocks.push(block);
    }
  }

  const previousFirstId = previous[0]?.id ?? null;
  const nextFirstId = next[0]?.id ?? null;
  if (previousFirstId !== nextFirstId) {
    const previousFirst = previousFirstId ? nextById.get(previousFirstId) : undefined;
    const nextFirst = nextFirstId ? nextById.get(nextFirstId) : undefined;

    if (previousFirst && !upsertBlocks.some((block) => block.id === previousFirst.id)) {
      upsertBlocks.push(previousFirst);
    }
    if (nextFirst && !upsertBlocks.some((block) => block.id === nextFirst.id)) {
      upsertBlocks.push(nextFirst);
    }
  }

  const blockOrder = stringArrayEquals(
    previous.map((block) => block.id),
    next.map((block) => block.id)
  )
    ? undefined
    : next.map((block) => block.id);

  return { upsertBlocks, removeBlockIds, blockOrder };
}

function blockEquals(previous: RenderBlock, next: RenderBlock): boolean {
  if (previous.kind !== next.kind || previous.id !== next.id) {
    return false;
  }

  switch (previous.kind) {
    case 'user':
      return next.kind === 'user' && previous.text === next.text;
    case 'assistant':
    case 'thinking':
      return (
        next.kind === previous.kind &&
        previous.text === next.text &&
        previous.live === next.live
      );
    case 'tool':
      return (
        next.kind === 'tool' &&
        previous.tone === next.tone &&
        previous.header === next.header &&
        previous.live === next.live &&
        stringArrayEquals(previous.body, next.body) &&
        stringArrayEquals(previous.footer, next.footer)
      );
    case 'diff':
      return (
        next.kind === 'diff' &&
        previous.title === next.title &&
        previous.diff === next.diff &&
        previous.filetype === next.filetype &&
        previous.view === next.view &&
        previous.live === next.live
      );
  }
}

function stringArrayEquals(previous: string[], next: string[]): boolean {
  if (previous.length !== next.length) {
    return false;
  }
  return previous.every((value, index) => value === next[index]);
}

function experimentListEquals(
  previous: ExperimentSummary[],
  next: ExperimentSummary[]
): boolean {
  if (previous.length !== next.length) {
    return false;
  }
  return previous.every(
    (experiment, index) =>
      experiment.id === next[index]?.id &&
      experiment.status === next[index]?.status &&
      experiment.summary === next[index]?.summary &&
      experiment.meta === next[index]?.meta
  );
}

function statusEquals(previous: State['status'], next: State['status']): boolean {
  return (
    previous.label === next.label &&
    previous.modeText === next.modeText &&
    previous.model === next.model &&
    previous.contextText === next.contextText &&
    previous.contextUsagePercent === next.contextUsagePercent &&
    previous.usageText === next.usageText &&
    previous.pendingText === next.pendingText
  );
}

function pendingUserRequestToBlock(snapshot: EngineSnapshot): RenderBlock {
  const request = snapshot.pendingUserRequest!;
  const body: string[] = [];
  if (request.context) {
    body.push(compactText(request.context, 96));
  }
  body.push(`question  ${compactText(request.question, 92)}`);

  if (request.responseKind === 'single_choice' && request.options?.length) {
    for (const option of request.options) {
      const suffix =
        option.id === request.recommendedOptionId ? ' [recommended]' : '';
      body.push(`${option.id}${suffix}  ${compactText(`${option.label} — ${option.description}`, 88)}`);
    }
  } else if (request.responseKind === 'yes_no' && request.recommendedResponse) {
    body.push(`recommended  ${request.recommendedResponse.toUpperCase()}`);
  }

  const footer = request.reason ? [compactText(request.reason, 96)] : [];
  return {
    id: `pending-user-request-${snapshot.session.id}`,
    kind: 'tool',
    tone: 'tool',
    header: `ask_user  ${request.kind}  ${request.responseKind}`,
    body,
    footer
  };
}

function transcriptEntryToBlocks(
  entry: TranscriptEntry,
  thinkingEnabled: boolean
): RenderBlock[] {
  if (entry.role === 'tool') {
    return toolTranscriptToBlocks(entry);
  }

  if (entry.role === 'assistant' && isExperimentNotice(entry.text)) {
    return [experimentNoticeToBlock(entry)];
  }

  if (entry.role === 'system' && entry.text.startsWith('@@thinking\t')) {
    if (!thinkingEnabled) {
      return [];
    }

    return [
      {
        id: `thinking-${entry.id}`,
        kind: 'thinking',
        text: entry.text.slice('@@thinking\t'.length)
      }
    ];
  }

  if (entry.role === 'user') {
    return [
      {
        id: `user-${entry.id}`,
        kind: 'user',
        text: entry.text
      }
    ];
  }

  return [
    {
      id: `assistant-${entry.id}`,
      kind: 'assistant',
      text: entry.text,
      tone: entry.text === INTERRUPTION_FOLLOWUP ? 'interruption' : 'default'
    }
  ];
}

function toolTranscriptToBlocks(
  entry: TranscriptEntry,
  forcedId?: string
): RenderBlock[] {
  const metadataMatch = entry.text.match(/^@@tool\t([^\t\n]+)\t([^\n]+)\n?([\s\S]*)$/);
  const legacyMatch = entry.text.match(/^\[([^\]]+)\]\n?([\s\S]*)$/);
  const toolName = metadataMatch?.[1]?.trim() || legacyMatch?.[1]?.trim() || 'tool';
  const explicitLabel = metadataMatch?.[2]?.trim() || null;
  const body = metadataMatch?.[3] ?? legacyMatch?.[2] ?? entry.text;

  if (toolName === 'edit_diff') {
    const patches = splitUnifiedDiffPatches(body);
    return patches.map((patch, index) => ({
      id: `${forcedId ?? `tool-${entry.id}`}-diff-${index}`,
      kind: 'diff',
      title:
        inferDiffTitle(patch) ||
        (patches.length === 1
          ? explicitLabel || 'Edit diff'
          : `${explicitLabel || 'Edit diff'} ${index + 1}/${patches.length}`),
      diff: patch,
      filetype: inferDiffFiletype(patch),
      view: 'unified'
    }));
  }

  const tone = getToolTone(toolName);
  const summary = summarizeToolTranscript(toolName, body, explicitLabel);

  return [
    {
      id: forcedId ?? `tool-${entry.id}`,
      kind: 'tool',
      tone,
      header: summary.label,
      body: summary.previewLines,
      footer: summary.footer ? [summary.footer] : []
    }
  ];
}

function experimentNoticeToBlock(entry: TranscriptEntry): RenderBlock {
  const lines = collapseBlankRuns(entry.text.split(/\r?\n/));
  const title = lines[0] ?? 'Experiment update';
  const fields = new Map<string, string>();

  for (const line of lines.slice(1)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const [, rawKey = '', rawValue = ''] = match;
    fields.set(rawKey.trim().toLowerCase(), rawValue.trim());
  }

  const id = fields.get('id');
  const verdict = fields.get('verdict');
  const hypothesis = fields.get('hypothesis');
  const summary = fields.get('summary') || fields.get('message');
  const budget = fields.get('budget');
  const discovered = fields.get('discovered');
  const confidence = fields.get('confidence');
  const cleanup = fields.get('cleanup') || fields.get('promote') || fields.get('next');

  const headerParts = [title];
  if (id) {
    headerParts.push(id);
  }
  if (verdict) {
    headerParts.push(verdict);
  }

  const body: string[] = [];
  if (hypothesis) {
    body.push(compactText(hypothesis, 96));
  }
  if (summary) {
    body.push(`summary  ${compactText(summary, 92)}`);
  }
  if (budget) {
    body.push(`budget  ${compactText(budget, 92)}`);
  }
  if (discovered) {
    body.push(`found  ${compactText(discovered, 92)}`);
  }
  if (confidence) {
    body.push(`confidence  ${compactText(confidence, 88)}`);
  }

  return {
    id: `notice-${entry.id}`,
    kind: 'tool',
    tone: 'experiment',
    header: headerParts.join('  '),
    body,
    footer: cleanup ? [compactText(cleanup, 96)] : []
  };
}

function summarizeExperiment(experiment: ExperimentRecord): ExperimentSummary {
  return {
    id: experiment.id,
    status: experiment.status,
    summary: experiment.finalSummary || experiment.hypothesis,
    meta: `${formatTokenCount(experiment.tokensUsed)}/${formatTokenCount(experiment.budget)}  ${formatAge(experiment.updatedAt)}`
  };
}

function summarizeToolTranscript(
  toolName: string,
  body: string,
  explicitLabel: string | null = null
): { label: string; previewLines: string[]; footer: string | null } {
  switch (toolName) {
    case 'glob':
      return summarizeGlobTool(body, explicitLabel);
    case 'read':
      return summarizeReadTool(body, explicitLabel);
    case 'exec_command':
    case 'write_stdin':
      return summarizeExecTool(toolName, body, explicitLabel);
    case 'compact':
      return summarizeCompactTool(body, explicitLabel);
    case 'spawn_experiment':
    case 'read_experiment':
    case 'wait_experiment':
    case 'search_experiments':
    case 'resolve_experiment':
    case 'experiment_notice':
    case 'extend_experiment_budget':
      return summarizeExperimentTool(toolName, body, explicitLabel);
    case 'open_question':
    case 'resolve_question':
    case 'open_study_debt':
    case 'resolve_study_debt':
      return summarizeStudyDebtTool(toolName, body, explicitLabel);
    default:
      return summarizeGenericTool(toolName, body, explicitLabel);
  }
}

function splitUnifiedDiffPatches(diffText: string): string[] {
  const normalized = diffText.replace(/\r\n/g, '\n');
  if (!normalized) {
    return [];
  }

  const segments = normalized.split(/^diff --git /m);
  if (segments.length === 1) {
    return [stripSingleTrailingNewline(normalized)];
  }

  return segments
    .slice(1)
    .map((segment) => stripSingleTrailingNewline(`diff --git ${segment}`))
    .filter(Boolean);
}

function stripSingleTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function inferDiffFiletype(diffText: string): string | undefined {
  const plusPlusMatch = diffText.match(/^\+\+\+ b\/(.+)$/m) || diffText.match(/^--- a\/(.+)$/m);
  const filePath = plusPlusMatch?.[1];
  if (!filePath) {
    return undefined;
  }

  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'typescriptreact';
    case '.js':
      return 'javascript';
    case '.jsx':
      return 'javascriptreact';
    case '.json':
      return 'json';
    case '.md':
      return 'markdown';
    case '.css':
      return 'css';
    case '.html':
      return 'html';
    case '.sh':
      return 'bash';
    case '.py':
      return 'python';
    case '.rs':
      return 'rust';
    default:
      return undefined;
  }
}

function inferDiffTitle(diffText: string): string | undefined {
  const plusPlusMatch = diffText.match(/^\+\+\+ b\/(.+)$/m) || diffText.match(/^--- a\/(.+)$/m);
  const filePath = plusPlusMatch?.[1]?.trim();
  if (!filePath) {
    return undefined;
  }

  return `Edit(${path.basename(filePath)})`;
}

function summarizeGlobTool(body: string, explicitLabel: string | null) {
  const parsed = safeJsonParse(body);
  if (!Array.isArray(parsed)) {
    return summarizeGenericTool('glob', body, explicitLabel);
  }

  const matches = parsed.filter((item): item is string => typeof item === 'string');
  return {
    label: explicitLabel || `Glob(${matches.length} ${matches.length === 1 ? 'match' : 'matches'})`,
    previewLines: matches.slice(0, 5),
    footer: matches.length > 5 ? `(${matches.length - 5} more matches)` : null
  };
}

function summarizeReadTool(body: string, explicitLabel: string | null) {
  const [pathLine, ...rest] = body.split(/\r?\n/);
  const content = rest.join('\n').replace(/^\n+/, '');
  const contentLines = content.length > 0 ? content.split(/\r?\n/) : [];
  const previewContent = contentLines.slice(0, 4);
  return {
    label: explicitLabel || `Read(${(pathLine ?? '').trim() || '(unknown file)'})`,
    previewLines: [`${contentLines.length} lines`, ...previewContent],
    footer:
      contentLines.length > previewContent.length
        ? `(${contentLines.length - previewContent.length} more lines)`
        : null
  };
}

function summarizeExecTool(toolName: string, body: string, explicitLabel: string | null) {
  const parsed = safeJsonParse(body);
  if (!parsed || typeof parsed !== 'object') {
    return summarizeGenericTool(toolName, body, explicitLabel);
  }

  const maybeObject = parsed as Record<string, unknown>;
  const previewLines: string[] = [];
  const command =
    typeof maybeObject.command === 'string' && maybeObject.command.trim().length > 0
      ? maybeObject.command
      : null;
  const processId =
    typeof maybeObject.processId === 'number' && Number.isFinite(maybeObject.processId)
      ? Math.floor(maybeObject.processId)
      : null;
  const exitCode =
    typeof maybeObject.exitCode === 'number' && Number.isFinite(maybeObject.exitCode)
      ? Math.floor(maybeObject.exitCode)
      : maybeObject.exitCode === null
        ? null
        : '?';
  const running = maybeObject.running === true;

  if (processId !== null) {
    previewLines.push(`process  ${processId}`);
  }
  previewLines.push(running ? 'status  running' : `exit  ${exitCode ?? '?'}`);

  const stdout = typeof maybeObject.stdout === 'string' ? maybeObject.stdout : '';
  const stderr = typeof maybeObject.stderr === 'string' ? maybeObject.stderr : '';
  const outputLines = collapseBlankRuns(
    [stdout, stderr]
      .filter((value) => value.trim().length > 0)
      .flatMap((value) => value.split(/\r?\n/))
  );
  previewLines.push(...outputLines.slice(0, 3).map((line) => compactText(line, 92)));

  return {
    label:
      explicitLabel ||
      (command ? `Exec(${compactText(command, 52)})` : processId !== null ? `Exec(${processId})` : 'Exec'),
    previewLines: previewLines.slice(0, 4),
    footer: outputLines.length > 3 ? `(${outputLines.length - 3} more lines)` : null
  };
}

function summarizeCompactTool(body: string, explicitLabel: string | null) {
  const rows = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return {
    label: explicitLabel || 'Compact',
    previewLines: rows.slice(0, 4),
    footer: rows.length > 4 ? `(${rows.length - 4} more lines)` : null
  };
}

function summarizeExperimentTool(
  toolName: string,
  body: string,
  explicitLabel: string | null
) {
  const parsed = safeJsonParse(body);
  const label =
    explicitLabel ||
    {
      spawn_experiment: 'experiment spawn',
      read_experiment: 'experiment read',
      wait_experiment: 'experiment wait',
      search_experiments: 'experiment search',
      resolve_experiment: 'experiment resolve',
      experiment_notice: explicitLabel || 'experiment update',
      extend_experiment_budget: 'experiment budget'
    }[toolName] ||
    toolName;

  if (!parsed || typeof parsed !== 'object') {
    return summarizeGenericTool(label, body, explicitLabel);
  }

  const previewLines: string[] = [];
  const maybeObject = parsed as Record<string, unknown>;

  if (typeof maybeObject.experimentId === 'string') {
    previewLines.push(maybeObject.experimentId);
  } else if (typeof maybeObject.id === 'string') {
    previewLines.push(maybeObject.id);
  }

  if (typeof maybeObject.status === 'string') {
    previewLines.push(`status  ${maybeObject.status}`);
  }
  if (typeof maybeObject.summary === 'string') {
    previewLines.push(compactText(maybeObject.summary, 92));
  }
  if (typeof maybeObject.hypothesis === 'string' && previewLines.length < 4) {
    previewLines.push(compactText(maybeObject.hypothesis, 92));
  }
  if (typeof maybeObject.lastObservationSnippet === 'string' && previewLines.length < 4) {
    previewLines.push(`last  ${compactText(maybeObject.lastObservationSnippet, 88)}`);
  }
  if (typeof maybeObject.next === 'string' && previewLines.length < 4) {
    previewLines.push(`next  ${compactText(maybeObject.next, 88)}`);
  }

  return {
    label,
    previewLines: previewLines.slice(0, 4),
    footer: Array.isArray(maybeObject.discovered)
      ? `(${maybeObject.discovered.length} findings)`
      : null
  };
}

function summarizeStudyDebtTool(
  toolName: string,
  body: string,
  explicitLabel: string | null
) {
  const parsed = safeJsonParse(body);
  const label =
    explicitLabel ||
    {
      open_question: 'open question',
      resolve_question: 'resolve question',
      open_study_debt: 'open question',
      resolve_study_debt: 'resolve question'
    }[toolName] ||
    toolName;

  if (!parsed || typeof parsed !== 'object') {
    return summarizeGenericTool(label, body, explicitLabel);
  }

  const previewLines: string[] = [];
  const maybeObject = parsed as Record<string, unknown>;
  const summary = typeof maybeObject.summary === 'string' ? maybeObject.summary : null;
  const status = typeof maybeObject.status === 'string' ? maybeObject.status : null;
  const resolution = typeof maybeObject.resolution === 'string' ? maybeObject.resolution : null;
  const note = typeof maybeObject.note === 'string' ? maybeObject.note : null;
  const questionId =
    (typeof maybeObject.questionId === 'string' && maybeObject.questionId) ||
    (typeof maybeObject.debtId === 'string' && maybeObject.debtId) ||
    (typeof maybeObject.id === 'string' && maybeObject.id) ||
    null;

  if (summary) {
    previewLines.push(`note  ${compactText(summary, 88)}`);
  } else if (questionId) {
    previewLines.push(questionId);
  }

  if (status) {
    previewLines.push(`status  ${status}`);
  }
  if (resolution) {
    previewLines.push(`resolution  ${resolution}`);
  }
  if (note) {
    previewLines.push(`note  ${compactText(note, 88)}`);
  }

  return {
    label: explicitLabel || (questionId ? `${label}(${questionId})` : label),
    previewLines: previewLines.slice(0, 4),
    footer: null
  };
}

function summarizeGenericTool(
  toolName: string,
  body: string,
  explicitLabel: string | null
) {
  const rows = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return {
    label: explicitLabel || toolName,
    previewLines: rows.slice(0, 4),
    footer: rows.length > 4 ? `(${rows.length - 4} more lines)` : null
  };
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function isExperimentTool(toolName: string): boolean {
  return toolName.includes('experiment');
}

function isStudyDebtTool(toolName: string): boolean {
  return toolName.includes('study_debt') || toolName.includes('question');
}

function getToolTone(toolName: string): ToolTone {
  if (isExperimentTool(toolName)) {
    return 'experiment';
  }

  if (isStudyDebtTool(toolName)) {
    return 'study_debt';
  }

  return 'tool';
}

function isExperimentNotice(text: string): boolean {
  return /^Experiment (resolved|budget exhausted|low-signal warning)/.test(text);
}

function collapseBlankRuns(lines: string[]): string[] {
  const output: string[] = [];
  let previousBlank = false;

  for (const line of lines) {
    const blank = line.trim().length === 0;
    if (blank && previousBlank) {
      continue;
    }
    output.push(line);
    previousBlank = blank;
  }

  while (output[0]?.trim().length === 0) {
    output.shift();
  }

  while (output[output.length - 1]?.trim().length === 0) {
    output.pop();
  }

  return output;
}

function compactText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function formatAge(iso: string): string {
  const millis = Date.now() - new Date(iso).getTime();
  const seconds = Math.max(0, Math.round(millis / 1000));

  if (seconds < 5) {
    return 'now';
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }

  const days = Math.round(hours / 24);
  return `${days}d`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return `${value}`;
}

function formatStatus(snapshot: EngineSnapshot): State['status'] {
  const ctxLimit = snapshot.effectiveContextBudgetTokens;
  const usedPercent = ctxLimit > 0 ? Math.max(0, Math.round((snapshot.estimatedContextTokens / ctxLimit) * 100)) : 0;
  const phaseSuffix =
    snapshot.agentMode === 'plan' && snapshot.planModePhase
      ? `/${snapshot.planModePhase.replace('_', '-')}`
      : '';

  return {
    label:
      snapshot.pendingUserRequest && snapshot.statusText === 'idle'
        ? 'waiting'
        : snapshot.statusText === 'running turn'
          ? 'running'
          : snapshot.statusText,
    modeText: `${snapshot.agentMode}${phaseSuffix}`,
    model: snapshot.model,
    contextText: `${formatTokenCount(snapshot.estimatedContextTokens)}/${formatTokenCount(ctxLimit)}`,
    contextUsagePercent: usedPercent,
    usageText: `${usedPercent}% used`,
    pendingText: formatPendingText(snapshot)
  };
}

function formatPendingText(snapshot: EngineSnapshot): string | null {
  if (snapshot.statusText === 'interrupted') {
    return INTERRUPTION_FOLLOWUP;
  }

  const request = snapshot.pendingUserRequest;
  if (!request) {
    return null;
  }
  if (request.responseKind === 'single_choice' && request.recommendedOptionId) {
    return `pick ${request.recommendedOptionId}`;
  }
  if (request.responseKind === 'yes_no' && request.recommendedResponse) {
    return request.recommendedResponse.toUpperCase();
  }
  return 'reply needed';
}
