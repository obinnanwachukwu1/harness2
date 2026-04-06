import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

import type { HeadlessEngine } from '../engine/headless-engine.js';
import type { EngineSnapshot, ExperimentRecord, TranscriptEntry } from '../types.js';

interface HarnessAppProps {
  engine: HeadlessEngine;
}

export function HarnessApp({ engine }: HarnessAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [snapshot, setSnapshot] = useState<EngineSnapshot>(engine.snapshot);
  const [composer, setComposer] = useState('');

  useEffect(() => engine.subscribe(() => setSnapshot(engine.snapshot)), [engine]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
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

  const transcriptLines = flattenTranscript(snapshot.transcript).slice(-28);
  const experimentLines = flattenExperiments(snapshot.experiments).slice(-28);
  const runningExperiments = snapshot.experiments.filter((item) => item.status === 'running').length;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Pane title="Transcript" width="70%">
          {transcriptLines.length > 0 ? (
            transcriptLines.map((line, index) => <Text key={`transcript-${index}`}>{line}</Text>)
          ) : (
            <Text color="gray">No transcript yet. Try /help.</Text>
          )}
        </Pane>

        <Pane title="Experiments" width="30%">
          {experimentLines.length > 0 ? (
            experimentLines.map((line, index) => <Text key={`experiments-${index}`}>{line}</Text>)
          ) : (
            <Text color="gray">No experiments yet.</Text>
          )}
        </Pane>
      </Box>

      <Box borderStyle="round" marginTop={1} paddingX={1}>
        <Text>
          session {snapshot.session.id} | {snapshot.statusText} | running experiments {runningExperiments}{' '}
          | {snapshot.session.cwd}
        </Text>
      </Box>

      <Box borderStyle="round" marginTop={1} paddingX={1}>
        <Text color="cyan">{'> '}</Text>
        <Text>{composer || '/help for commands'}</Text>
        <Text color="cyan">{composer ? '_' : ''}</Text>
      </Box>
    </Box>
  );
}

interface PaneProps {
  title: string;
  width: string;
  children: React.ReactNode;
}

function Pane({ title, width, children }: PaneProps): React.JSX.Element {
  return (
    <Box width={width} borderStyle="round" paddingX={1} flexDirection="column">
      <Text bold>{title}</Text>
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
}

function flattenTranscript(entries: TranscriptEntry[]): string[] {
  return entries.flatMap((entry) => {
    const prefix = `[${entry.role}]`;
    const rows = entry.text.split(/\r?\n/);
    return rows.map((row, index) => (index === 0 ? `${prefix} ${row}` : `  ${row}`));
  });
}

function flattenExperiments(experiments: ExperimentRecord[]): string[] {
  return experiments.flatMap((experiment) => {
    const rows = [
      `${experiment.id} [${experiment.status}]`,
      `  ${experiment.hypothesis}`,
      `  tokens ${experiment.tokensUsed}/${experiment.budget}`,
      `  ${experiment.worktreePath}`
    ];

    if (experiment.finalSummary) {
      rows.push(`  ${experiment.finalSummary}`);
    }

    return rows;
  });
}
