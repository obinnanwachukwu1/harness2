import type { EngineSnapshot, ExperimentRecord, TranscriptEntry } from '../types.js';
import type { OpenTuiExperimentSummary, OpenTuiRenderBlock, OpenTuiState } from './render-types.js';

type ToolTone = Extract<OpenTuiRenderBlock, { kind: 'tool' }>['tone'];

const INPUT_PLACEHOLDER = 'Send a prompt…';

export function buildOpenTuiState(snapshot: EngineSnapshot): OpenTuiState {
  return {
    sessionId: snapshot.session.id,
    cwd: snapshot.session.cwd,
    status: formatStatus(snapshot),
    thinkingEnabled: snapshot.thinkingEnabled,
    inputPlaceholder: INPUT_PLACEHOLDER,
    blocks: buildBlocks(snapshot),
    experiments: snapshot.experiments.map(summarizeExperiment)
  };
}

function buildBlocks(snapshot: EngineSnapshot): OpenTuiRenderBlock[] {
  const currentTurnStartedAt =
    snapshot.processingTurn && snapshot.currentTurnStartedAt ? snapshot.currentTurnStartedAt : null;
  const historicalEntries = currentTurnStartedAt
    ? snapshot.transcript.filter(
        (entry) => !(entry.role !== 'user' && entry.createdAt >= currentTurnStartedAt)
      )
    : snapshot.transcript;

  const blocks = historicalEntries.flatMap((entry) =>
    transcriptEntryToBlocks(entry, snapshot.thinkingEnabled)
  );

  for (const event of snapshot.liveTurnEvents) {
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
      const block = toolTranscriptToBlock(
        {
          id: -1,
          sessionId: snapshot.session.id,
          role: 'tool',
          text: event.transcriptText,
          createdAt: currentTurnStartedAt ?? snapshot.session.lastActiveAt
        },
        event.id
      );
      block.live = event.live;
      blocks.push(block);
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

  return blocks;
}

function transcriptEntryToBlocks(
  entry: TranscriptEntry,
  thinkingEnabled: boolean
): OpenTuiRenderBlock[] {
  if (entry.role === 'tool') {
    return [toolTranscriptToBlock(entry)];
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
      text: entry.text
    }
  ];
}

function toolTranscriptToBlock(
  entry: TranscriptEntry,
  forcedId?: string
): Extract<OpenTuiRenderBlock, { kind: 'tool' }> {
  const metadataMatch = entry.text.match(/^@@tool\t([^\t\n]+)\t([^\n]+)\n?([\s\S]*)$/);
  const legacyMatch = entry.text.match(/^\[([^\]]+)\]\n?([\s\S]*)$/);
  const toolName = metadataMatch?.[1]?.trim() || legacyMatch?.[1]?.trim() || 'tool';
  const explicitLabel = metadataMatch?.[2]?.trim() || null;
  const body = metadataMatch?.[3] ?? legacyMatch?.[2] ?? entry.text;
  const tone = getToolTone(toolName);
  const summary = summarizeToolTranscript(toolName, body, explicitLabel);

  return {
    id: forcedId ?? `tool-${entry.id}`,
    kind: 'tool',
    tone,
    header: summary.label,
    body: summary.previewLines,
    footer: summary.footer ? [summary.footer] : []
  };
}

function experimentNoticeToBlock(entry: TranscriptEntry): OpenTuiRenderBlock {
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

function summarizeExperiment(experiment: ExperimentRecord): OpenTuiExperimentSummary {
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
    case 'bash':
      return summarizeBashTool(body, explicitLabel);
    case 'compact':
      return summarizeCompactTool(body, explicitLabel);
    case 'spawn_experiment':
    case 'read_experiment':
    case 'wait_experiment':
    case 'search_experiments':
    case 'resolve_experiment':
    case 'extend_experiment_budget':
      return summarizeExperimentTool(toolName, body, explicitLabel);
    case 'open_question':
    case 'resolve_question':
    case 'open_study_debt':
    case 'resolve_study_debt':
      return summarizeStudyDebtTool(toolName, body, explicitLabel);
    default:
      return summarizeGenericTool(toolName, body, explicitLabel, false);
  }
}

function summarizeGlobTool(body: string, explicitLabel: string | null) {
  const parsed = safeJsonParse(body);
  if (!Array.isArray(parsed)) {
    return summarizeGenericTool('glob', body, explicitLabel, false);
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

function summarizeBashTool(body: string, explicitLabel: string | null) {
  const rows = body.split(/\r?\n/);
  const command = rows.find((line) => line.startsWith('$ '))?.slice(2).trim() ?? '(command)';
  const exitLine = rows.find((line) => line.startsWith('exit:')) ?? 'exit: ?';
  const stdoutIndex = rows.findIndex((line) => line === 'stdout:');
  const stderrIndex = rows.findIndex((line) => line === 'stderr:');
  const outputStart = stdoutIndex >= 0 ? stdoutIndex + 1 : stderrIndex >= 0 ? stderrIndex + 1 : -1;
  const outputLines =
    outputStart >= 0
      ? rows.slice(outputStart).filter((line) => line.trim().length > 0)
      : rows.filter((line) => !line.startsWith('$ ') && !line.startsWith('exit:'));
  const preview = outputLines.slice(0, 4);

  return {
    label: explicitLabel || `Bash(${compactText(command, 52)})`,
    previewLines: [exitLine.replace(/^exit:\s*/, 'exit '), ...preview],
    footer: outputLines.length > preview.length ? `(${outputLines.length - preview.length} more lines)` : null
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
      extend_experiment_budget: 'experiment budget'
    }[toolName] ||
    toolName;

  if (!parsed || typeof parsed !== 'object') {
    return summarizeGenericTool(label, body, explicitLabel, true);
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
  if (typeof maybeObject.hypothesis === 'string' && previewLines.length < 3) {
    previewLines.push(compactText(maybeObject.hypothesis, 92));
  }
  if (typeof maybeObject.lastObservationSnippet === 'string' && previewLines.length < 4) {
    previewLines.push(`last  ${compactText(maybeObject.lastObservationSnippet, 88)}`);
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
    return summarizeGenericTool(label, body, explicitLabel, false);
  }

  const previewLines: string[] = [];
  const maybeObject = parsed as Record<string, unknown>;

  if (typeof maybeObject.questionId === 'string') {
    previewLines.push(maybeObject.questionId);
  } else if (typeof maybeObject.debtId === 'string') {
    previewLines.push(maybeObject.debtId);
  } else if (typeof maybeObject.id === 'string') {
    previewLines.push(maybeObject.id);
  }

  if (typeof maybeObject.status === 'string') {
    previewLines.push(`status  ${maybeObject.status}`);
  }

  return {
    label,
    previewLines: previewLines.slice(0, 4),
    footer: null
  };
}

function summarizeGenericTool(
  toolName: string,
  body: string,
  explicitLabel: string | null,
  experimentTone: boolean
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

function formatStatus(snapshot: EngineSnapshot): OpenTuiState['status'] {
  const ctxLimit = snapshot.standardRateContextTokens || snapshot.contextWindowTokens;
  const usedPercent = ctxLimit > 0 ? Math.max(0, Math.round((snapshot.estimatedContextTokens / ctxLimit) * 100)) : 0;

  return {
    label: snapshot.statusText === 'running turn' ? 'running' : snapshot.statusText,
    model: snapshot.model,
    contextText: `${formatTokenCount(snapshot.estimatedContextTokens)}/${formatTokenCount(ctxLimit)}`,
    contextUsagePercent: usedPercent,
    usageText: `${usedPercent}% used`
  };
}
