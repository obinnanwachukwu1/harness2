import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';

import type { HeadlessEngine } from '../engine/headless-engine.js';
import type { EngineSnapshot, ExperimentRecord, TranscriptEntry } from '../types.js';

interface HarnessAppProps {
  engine: HeadlessEngine;
}

export function HarnessApp({ engine }: HarnessAppProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [snapshot, setSnapshot] = useState<EngineSnapshot>(engine.snapshot);
  const [composer, setComposer] = useState('');
  const [scrollOffset, setScrollOffset] = useState(0);
  const stdoutColumns = stdout.columns ?? 80;
  const stdoutRows = stdout.rows ?? 24;

  useEffect(() => engine.subscribe(() => setSnapshot(engine.snapshot)), [engine]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    if (key.upArrow) {
      setScrollOffset((current) => current + 1);
      return;
    }

    if (key.downArrow) {
      setScrollOffset((current) => Math.max(0, current - 1));
      return;
    }

    if (key.pageUp) {
      setScrollOffset((current) => current + Math.max(5, Math.floor(stdoutRows / 3)));
      return;
    }

    if (key.pageDown) {
      setScrollOffset((current) => Math.max(0, current - Math.max(5, Math.floor(stdoutRows / 3))));
      return;
    }

    if (key.escape) {
      setScrollOffset(0);
      return;
    }

    if (key.return) {
      const submitted = composer.trim();
      if (!submitted) {
        return;
      }

      if (submitted === '/quit') {
        exit();
        return;
      }

      setScrollOffset(0);
      setComposer('');
      void engine.submit(submitted);
      return;
    }

    if (key.backspace || key.delete) {
      setComposer((current) => current.slice(0, -1));
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      setComposer((current) => current + input);
    }
  });

  const experimentLines = flattenExperiments(snapshot.experiments);
  const runningExperiments = snapshot.experiments.filter((item) => item.status === 'running').length;
  const visibleExperimentCount = Math.min(experimentLines.length, 3);
  const experimentSectionRows = visibleExperimentCount > 0 ? 2 + visibleExperimentCount : 0;
  const transcriptRows = Math.max(4, stdoutRows - (1 + experimentSectionRows + 1 + 1 + 1 + 2));
  const allTranscriptLines = buildTranscriptLines(
    snapshot.transcript,
    stdoutColumns,
    snapshot.liveAssistantText
  );
  const maxScrollOffset = Math.max(0, allTranscriptLines.length - transcriptRows);
  const clampedScrollOffset = Math.min(scrollOffset, maxScrollOffset);
  const transcriptLines = selectVisibleTranscriptLines(
    allTranscriptLines,
    transcriptRows,
    clampedScrollOffset
  );
  const transcriptBoxRows = Math.max(
    1,
    Math.min(
      transcriptRows,
      transcriptLines.length > 0 ? transcriptLines.length : 1
    )
  );
  const statusColor = snapshot.statusText === 'error' ? 'red' : snapshot.processingTurn ? 'yellow' : 'green';
  const modelLabel = `${snapshot.model} / ${snapshot.reasoningEffort ?? 'off'}`;
  const contextLabel = `ctx ${formatTokenCount(snapshot.estimatedContextTokens)}/${formatTokenCount(snapshot.contextWindowTokens)}`;
  const contextColor = getContextColor(
    snapshot.estimatedContextTokens,
    snapshot.contextWindowTokens
  );
  const location = compactPath(
    snapshot.session.cwd,
    Math.max(20, stdoutColumns - modelLabel.length - contextLabel.length - 34)
  );
  const scrollLabel =
    maxScrollOffset > 0
      ? `  scroll ${maxScrollOffset - clampedScrollOffset + 1}/${maxScrollOffset + 1}`
      : '';

  return (
    <Box flexDirection="column" height={stdoutRows} width={stdoutColumns}>
      <Box>
        <Text>{` h2`}</Text>
        <Text dimColor>{`  ${snapshot.session.id}`}</Text>
      </Box>

      {experimentLines.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>experiments</Text>
          {experimentLines.slice(0, 3).map((line, index) => (
            <Text key={`experiments-${index}`} color={index === 0 ? 'yellow' : undefined}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      <Box flexDirection="column" height={transcriptBoxRows} marginTop={1}>
        {transcriptLines.length > 0 ? (
          transcriptLines.map((line, index) => renderTranscriptLine(line, stdoutColumns, index))
        ) : (
          <Text dimColor>{` Type a task or run /help.`}</Text>
        )}
      </Box>

      <Box>
        <Text dimColor>{'─'.repeat(Math.max(8, stdoutColumns))}</Text>
      </Box>

      <Box>
        <Text>{' '}</Text>
        <Text color={statusColor}>{snapshot.statusText}</Text>
        <Text dimColor>{`  ${modelLabel}  `}</Text>
        <Text color={contextColor}>{contextLabel}</Text>
        <Text dimColor>{`  exp ${runningExperiments}/${snapshot.experiments.length}${scrollLabel}  ${location}`}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color="cyan">{` › `}</Text>
        <Text>
          {composer || 'Type a message or /help.'}
        </Text>
      </Box>
    </Box>
  );
}

function flattenExperiments(experiments: ExperimentRecord[]): string[] {
  return experiments.slice(0, 3).map((experiment) => {
    const summary =
      experiment.finalSummary ||
      experiment.discovered[0] ||
      experiment.hypothesis;
    const quality = experiment.lowSignalWarningEmitted ? '  low-signal' : '';
    return `${experiment.id}  ${experiment.status}  ${formatTokenCount(experiment.tokensUsed)}/${formatTokenCount(experiment.budget)}  ${formatAge(experiment.updatedAt)}${quality}  ${compactText(summary, 44)}`;
  });
}

function compactText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit - 1)}…`;
}

function compactPath(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  const suffix = value.slice(-(limit - 1));
  return `…${suffix}`;
}

function formatAge(timestamp: string): string {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) {
    return 'now';
  }

  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 5) {
    return 'now';
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const rounded = Math.round((value / 1_000_000) * 10) / 10;
    return `${rounded.toFixed(rounded % 1 === 0 ? 0 : 1)}M`;
  }

  if (value >= 1_000) {
    const rounded = Math.round((value / 1_000) * 10) / 10;
    return `${rounded.toFixed(rounded % 1 === 0 ? 0 : 1)}k`;
  }

  return `${value}`;
}

function getContextColor(used: number, total: number): 'green' | 'yellow' | 'red' | undefined {
  if (total <= 0) {
    return undefined;
  }

  const ratio = used / total;
  if (ratio >= 0.9) {
    return 'red';
  }

  if (ratio >= 0.75) {
    return 'yellow';
  }

  if (ratio >= 0.5) {
    return 'green';
  }

  return undefined;
}

interface TranscriptRenderLine {
  text: string;
  role: TranscriptEntry['role'] | 'live-assistant';
  kind:
    | 'user'
    | 'assistant'
    | 'tool-header'
    | 'tool-body'
    | 'tool-footer'
    | 'experiment-header'
    | 'experiment-body'
    | 'experiment-footer';
}

function renderTranscriptLine(
  line: TranscriptRenderLine,
  width: number,
  index: number
): React.JSX.Element {
  if (line.kind === 'user') {
    return (
      <Text key={`line-${index}`} backgroundColor="gray" color="white">
        {padLine(` ${line.text}`, width)}
      </Text>
    );
  }

  if (line.kind === 'tool-header') {
    return (
      <Text key={`line-${index}`} dimColor bold>
        {truncateLine(` ⏺ ${line.text}`, width)}
      </Text>
    );
  }

  if (line.kind === 'experiment-header') {
    return (
      <Text key={`line-${index}`} color="yellow" bold>
        {truncateLine(` ⏺ ${line.text}`, width)}
      </Text>
    );
  }

  if (line.kind === 'tool-body' || line.kind === 'experiment-body') {
    return (
      <Text
        key={`line-${index}`}
        dimColor={line.kind === 'tool-body'}
        color={line.kind === 'experiment-body' ? 'yellow' : undefined}
      >
        {line.text.length > 0 ? `   ${line.text}` : ''}
      </Text>
    );
  }

  if (line.kind === 'tool-footer' || line.kind === 'experiment-footer') {
    return (
      <Text
        key={`line-${index}`}
        dimColor={line.kind === 'tool-footer'}
        color={line.kind === 'experiment-footer' ? 'yellow' : undefined}
      >
        {line.text.length > 0 ? `   ${line.text}` : ''}
      </Text>
    );
  }

  return (
    <Text
      key={`line-${index}`}
      dimColor={line.role === 'tool'}
      color={line.kind === 'assistant' ? undefined : 'yellow'}
    >
      {line.text.length > 0 ? ` ${line.text}` : ''}
    </Text>
  );
}

function buildTranscriptLines(
  entries: TranscriptEntry[],
  width: number,
  liveAssistantText: string | null
): TranscriptRenderLine[] {
  const allLines = entries.flatMap((entry) => flattenTranscriptEntry(entry, width));
  if (liveAssistantText && liveAssistantText.trim()) {
    allLines.push(...flattenTranscriptText('assistant', liveAssistantText, width));
  }

  return allLines;
}

function selectVisibleTranscriptLines(
  allLines: TranscriptRenderLine[],
  maxLines: number,
  scrollOffset: number
): TranscriptRenderLine[] {
  const end = Math.max(0, allLines.length - scrollOffset);
  const start = Math.max(0, end - maxLines);
  return allLines.slice(start, end);
}

function flattenTranscriptEntry(entry: TranscriptEntry, width: number): TranscriptRenderLine[] {
  return flattenTranscriptText(entry.role, entry.text, width);
}

function flattenTranscriptText(
  role: TranscriptEntry['role'],
  text: string,
  width: number
): TranscriptRenderLine[] {
  if (role === 'tool') {
    return flattenToolTranscriptText(text, width);
  }

  if (role === 'assistant' && isExperimentNotice(text)) {
    return flattenExperimentNotice(text, width);
  }

  const rows = collapseBlankRuns(wrapBlocks(text, Math.max(12, width - 2)));
  const lines: TranscriptRenderLine[] = rows.map((row) => ({
    text: row,
    role,
    kind: role === 'user' ? 'user' : 'assistant'
  }));

  return lines;
}

function flattenToolTranscriptText(text: string, width: number): TranscriptRenderLine[] {
  const metadataMatch = text.match(/^@@tool\t([^\t\n]+)\t([^\n]+)\n?([\s\S]*)$/);
  const legacyMatch = text.match(/^\[([^\]]+)\]\n?([\s\S]*)$/);
  const toolName = metadataMatch?.[1]?.trim() || legacyMatch?.[1]?.trim() || 'tool';
  const explicitLabel = metadataMatch?.[2]?.trim() || null;
  const body = metadataMatch?.[3] ?? legacyMatch?.[2] ?? text;
  const experimentTool = isExperimentTool(toolName);
  const bodyWidth = Math.max(12, width - 4);
  const summary = summarizeToolTranscript(toolName, body, explicitLabel);
  const rows = collapseBlankRuns(
    wrapBlocks(summary.previewLines.filter((line) => line.trim().length > 0).join('\n'), bodyWidth)
  );
  const headerSummary = rows[0] ?? null;
  const detailRows = headerSummary ? rows.slice(1) : rows;
  const visibleRows = detailRows.slice(0, 5);
  const hiddenRowCount = Math.max(0, detailRows.length - visibleRows.length);
  const headerKind = experimentTool ? 'experiment-header' : 'tool-header';
  const bodyKind = experimentTool ? 'experiment-body' : 'tool-body';
  const footerKind = experimentTool ? 'experiment-footer' : 'tool-footer';
  const label = headerSummary ? `${summary.label}  ${headerSummary}` : summary.label;

  const lines: TranscriptRenderLine[] = [
    {
      text: label,
      role: 'tool',
      kind: headerKind as TranscriptRenderLine['kind']
    },
    ...visibleRows.map((row, index) => ({
      text: index === 0 ? `⎿ ${row}` : `  ${row}`,
      role: 'tool' as const,
      kind: bodyKind as TranscriptRenderLine['kind']
    }))
  ];

  if (summary.footer) {
    lines.push({
      text: visibleRows.length === 0 ? `⎿ ${summary.footer}` : `  ${summary.footer}`,
      role: 'tool',
      kind: footerKind as TranscriptRenderLine['kind']
    });
  }

  if (hiddenRowCount > 0) {
    lines.push({
      text: visibleRows.length === 0 && !summary.footer
        ? `⎿ (${hiddenRowCount} more lines)`
        : `  (${hiddenRowCount} more lines)`,
      role: 'tool',
      kind: footerKind as TranscriptRenderLine['kind']
    });
  }

  return lines;
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
    default:
      return summarizeGenericTool(toolName, body, explicitLabel, false);
  }
}

function summarizeGlobTool(body: string, explicitLabel: string | null): {
  label: string;
  previewLines: string[];
  footer: string | null;
} {
  const parsed = safeJsonParse(body);
  if (!Array.isArray(parsed)) {
    return summarizeGenericTool('glob', body, explicitLabel, false);
  }

  const matches = parsed.filter((item): item is string => typeof item === 'string');
  const label = explicitLabel || `Glob (${matches.length} ${matches.length === 1 ? 'match' : 'matches'})`;
  return {
    label,
    previewLines: matches.slice(0, 5),
    footer: matches.length > 5 ? `(${matches.length - 5} more matches)` : null
  };
}

function summarizeReadTool(body: string, explicitLabel: string | null): {
  label: string;
  previewLines: string[];
  footer: string | null;
} {
  const [pathLine, ...rest] = body.split(/\r?\n/);
  const content = rest.join('\n').replace(/^\n+/, '');
  const contentLines = content.length > 0 ? content.split(/\r?\n/) : [];
  const previewContent = contentLines.slice(0, 4);
  return {
    label: explicitLabel || `Read(${pathLine.trim() || '(unknown file)'})`,
    previewLines: [`${contentLines.length} lines`, ...previewContent],
    footer: contentLines.length > previewContent.length
      ? `(${contentLines.length - previewContent.length} more lines)`
      : null
  };
}

function summarizeBashTool(body: string, explicitLabel: string | null): {
  label: string;
  previewLines: string[];
  footer: string | null;
} {
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
    label: explicitLabel || `Bash(${compactText(command, 60)})`,
    previewLines: [exitLine.replace('exit:', 'exit').trim(), ...preview],
    footer: outputLines.length > preview.length ? `(${outputLines.length - preview.length} more lines)` : null
  };
}

function summarizeCompactTool(body: string, explicitLabel: string | null): {
  label: string;
  previewLines: string[];
  footer: string | null;
} {
  const parsed = safeJsonParse(body) as { checkpointId?: number } | null;
  return {
    label: explicitLabel ||
      (
      parsed && typeof parsed.checkpointId === 'number'
        ? `Compact checkpoint #${parsed.checkpointId}`
        : 'Compact'
      ),
    previewLines: [],
    footer: null
  };
}

function summarizeExperimentTool(
  toolName: string,
  body: string,
  explicitLabel: string | null
): { label: string; previewLines: string[]; footer: string | null } {
  const parsed = safeJsonParse(body);

  if (toolName === 'search_experiments' && Array.isArray(parsed)) {
    const results = parsed.filter(
      (item): item is { experimentId?: string; status?: string; summary?: string; hypothesis?: string } =>
        Boolean(item) && typeof item === 'object'
    );
    return {
      label: explicitLabel || `experiment search (${results.length} ${results.length === 1 ? 'result' : 'results'})`,
      previewLines: results.slice(0, 4).map((item) => {
        const id = item.experimentId ?? 'unknown';
        const status = item.status ?? 'unknown';
        const summary = item.summary ?? item.hypothesis ?? '';
        return `${id}  ${status}  ${compactText(summary, 52)}`;
      }),
      footer: results.length > 4 ? `(${results.length - 4} more results)` : null
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return summarizeGenericTool(toolName, body, explicitLabel, true);
  }

  const record = parsed as Record<string, unknown>;
  const id =
    typeof record.id === 'string'
      ? record.id
      : typeof record.experimentId === 'string'
        ? record.experimentId
        : 'unknown';
  const status =
    typeof record.status === 'string'
      ? record.status
      : typeof record.verdict === 'string'
        ? record.verdict
        : null;
  const labelBase = `experiment ${formatExperimentToolLabel(toolName)}`;
  const label = explicitLabel || (status ? `${labelBase} ${id}  ${status}` : `${labelBase} ${id}`);
  const previewLines: string[] = [];

  if (typeof record.hypothesis === 'string' && record.hypothesis.trim()) {
    previewLines.push(compactText(record.hypothesis, 80));
  }
  if (typeof record.summary === 'string' && record.summary.trim()) {
    previewLines.push(`summary  ${compactText(record.summary, 76)}`);
  }
  if (typeof record.budget === 'number') {
    const used =
      typeof record.tokensUsed === 'number'
        ? record.tokensUsed
        : typeof record.tokens_used === 'number'
          ? record.tokens_used
          : null;
    previewLines.push(
      used === null ? `budget  ${record.budget}` : `budget  ${used}/${record.budget}`
    );
  }
  if (typeof record.lastObservationSnippet === 'string' && record.lastObservationSnippet.trim()) {
    previewLines.push(`last  ${compactText(record.lastObservationSnippet, 76)}`);
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
  explicitLabel: string | null = null,
  experimentTool = false
): { label: string; previewLines: string[]; footer: string | null } {
  const label =
    explicitLabel ||
    (experimentTool
      ? `experiment ${formatExperimentToolLabel(toolName)}`
      : formatToolLabel(toolName));
  const previewLines = collapseBlankRuns(body.split(/\r?\n/)).slice(0, 4);
  const totalLines = collapseBlankRuns(body.split(/\r?\n/)).length;
  return {
    label,
    previewLines,
    footer: totalLines > previewLines.length ? `(${totalLines - previewLines.length} more lines)` : null
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function flattenExperimentNotice(text: string, width: number): TranscriptRenderLine[] {
  const rows = collapseBlankRuns(wrapBlocks(text, Math.max(12, width - 4)));
  if (rows.length === 0) {
    return [];
  }

  return rows.map((row, index) => ({
    text: row,
    role: 'assistant' as const,
    kind: index === 0 ? 'experiment-header' : 'experiment-body'
  }));
}

function isExperimentNotice(text: string): boolean {
  return (
    text.startsWith('Experiment resolved') ||
    text.startsWith('Experiment budget exhausted') ||
    text.startsWith('Experiment low-signal warning')
  );
}

function isExperimentTool(toolName: string): boolean {
  return (
    toolName === 'spawn_experiment' ||
    toolName === 'read_experiment' ||
    toolName === 'wait_experiment' ||
    toolName === 'search_experiments' ||
    toolName === 'resolve_experiment' ||
    toolName === 'extend_experiment_budget'
  );
}

function formatExperimentToolLabel(toolName: string): string {
  switch (toolName) {
    case 'spawn_experiment':
      return 'spawn';
    case 'read_experiment':
      return 'read';
    case 'wait_experiment':
      return 'wait';
    case 'search_experiments':
      return 'search';
    case 'resolve_experiment':
      return 'resolve';
    case 'extend_experiment_budget':
      return 'budget';
    default:
      return toolName;
  }
}

function formatToolLabel(toolName: string): string {
  switch (toolName) {
    case 'bash':
      return 'Bash';
    case 'read':
      return 'Read';
    case 'write':
      return 'Write';
    case 'edit':
      return 'Edit';
    case 'glob':
      return 'Glob';
    case 'grep':
      return 'Grep';
    case 'compact':
      return 'Compact';
    default:
      return toolName.replaceAll('_', ' ');
  }
}

function collapseBlankRuns(rows: string[]): string[] {
  const collapsed: string[] = [];
  let previousWasBlank = false;

  for (const row of rows) {
    const isBlank = row.trim().length === 0;
    if (isBlank && previousWasBlank) {
      continue;
    }

    collapsed.push(row);
    previousWasBlank = isBlank;
  }

  return collapsed;
}

function wrapBlocks(text: string, width: number): string[] {
  const sourceRows = text.split(/\r?\n/);
  const wrapped: string[] = [];

  for (const sourceRow of sourceRows) {
    if (sourceRow.length === 0) {
      wrapped.push('');
      continue;
    }

    wrapped.push(...wrapLine(sourceRow, width));
  }

  return wrapped;
}

function wrapLine(line: string, width: number): string[] {
  const bulletMatch = line.match(/^(\s*(?:[-*+]|\d+[.)]))(\s+)(.*)$/);
  if (bulletMatch) {
    const [, marker, spacing, remainder] = bulletMatch;
    const firstPrefix = `${marker}${spacing}`;
    const continuationPrefix = ' '.repeat(firstPrefix.length);
    return wrapWithPrefixes(remainder, width, firstPrefix, continuationPrefix);
  }

  const indentMatch = line.match(/^(\s+)(.*)$/);
  if (indentMatch) {
    const [, indent, remainder] = indentMatch;
    return wrapWithPrefixes(remainder, width, indent, indent);
  }

  return wrapWithPrefixes(line, width, '', '');
}

function wrapWithPrefixes(
  text: string,
  width: number,
  firstPrefix: string,
  continuationPrefix: string
): string[] {
  const chunks: string[] = [];
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const firstContentWidth = Math.max(1, width - firstPrefix.length);
  const continuationContentWidth = Math.max(1, width - continuationPrefix.length);
  let current = '';
  let currentWidth = firstContentWidth;
  let currentPrefix = firstPrefix;

  for (const word of words) {
    if (word.length > currentWidth) {
      if (current.length > 0) {
        chunks.push(`${currentPrefix}${current}`);
        current = '';
        currentPrefix = continuationPrefix;
        currentWidth = continuationContentWidth;
      }

      let remaining = word;
      while (remaining.length > currentWidth) {
        chunks.push(`${currentPrefix}${remaining.slice(0, currentWidth)}`);
        remaining = remaining.slice(currentWidth);
        currentPrefix = continuationPrefix;
        currentWidth = continuationContentWidth;
      }

      current = remaining;
      continue;
    }

    const candidate = current.length > 0 ? `${current} ${word}` : word;
    if (candidate.length <= currentWidth) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      chunks.push(`${currentPrefix}${current}`);
    }

    current = word;
    currentPrefix = continuationPrefix;
    currentWidth = continuationContentWidth;
  }

  if (current.length > 0) {
    chunks.push(`${currentPrefix}${current}`);
  }

  return chunks.length > 0 ? chunks : [firstPrefix.trimEnd()];
}

function padLine(text: string, width: number): string {
  if (text.length >= width) {
    return text.slice(0, width);
  }

  return text.padEnd(width, ' ');
}

function truncateLine(text: string, width: number): string {
  if (text.length <= width) {
    return text.padEnd(width, ' ');
  }

  if (width <= 1) {
    return text.slice(0, width);
  }

  return `${text.slice(0, width - 1)}…`;
}
