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
    const summary = compactText(experiment.hypothesis, 56);
    return `${experiment.id}  ${experiment.status}  ${summary}`;
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
}

function renderTranscriptLine(
  line: TranscriptRenderLine,
  width: number,
  index: number
): React.JSX.Element {
  if (line.role === 'user') {
    return (
      <Text key={`line-${index}`} backgroundColor="gray" color="white">
        {padLine(` ${line.text}`, width)}
      </Text>
    );
  }

  return (
    <Text key={`line-${index}`} dimColor={line.role === 'tool'}>
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
  const rows = collapseBlankRuns(wrapBlocks(text, Math.max(12, width - 2)));
  const visibleRows = role === 'tool' ? rows.slice(0, 8) : rows;
  const hiddenToolRowCount = role === 'tool' ? Math.max(0, rows.length - visibleRows.length) : 0;
  const lines: TranscriptRenderLine[] = visibleRows.map((row) => ({
    text: row,
    role
  }));

  if (hiddenToolRowCount > 0) {
    lines.push({
      text: `(${hiddenToolRowCount} more lines)`,
      role: 'tool'
    });
  }

  return lines;
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
