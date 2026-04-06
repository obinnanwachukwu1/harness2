#!/usr/bin/env node
import { stdout as output } from 'node:process';

import React from 'react';
import { render } from 'ink';

import { OpenAICodexAuth } from './auth/openai-codex.js';
import { runDoctor } from './commands/doctor.js';
import { HeadlessEngine } from './engine/headless-engine.js';
import { Notebook } from './storage/notebook.js';
import { HarnessApp } from './ui/app.js';
import type { ExperimentRecord, ModelHistoryItem, TranscriptEntry } from './types.js';

async function main(): Promise<void> {
  const [, , ...args] = process.argv;
  const printRequest = parsePrintRequest(args);
  if (printRequest) {
    await runPrintMode(printRequest.prompt, printRequest.sessionId);
    return;
  }

  const command = args[0];

  if (command === 'doctor') {
    const report = await runDoctor(process.cwd());
    printDoctor(report);
    if (!report.healthy) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'auth') {
    await runAuthCommand(args.slice(1));
    return;
  }

  const sessionId = command === 'resume' ? args[1] : undefined;
  if (command === 'resume' && !sessionId) {
    throw new Error('Usage: h2 resume <sessionId>');
  }

  if (command && command !== 'resume') {
    throw new Error(`Unknown command: ${command}`);
  }

  const engine = await HeadlessEngine.open({
    cwd: process.cwd(),
    sessionId
  });

  const app = render(React.createElement(HarnessApp, { engine }));
  try {
    await app.waitUntilExit();
  } finally {
    await engine.dispose();
  }
}

async function runPrintMode(prompt: string, sessionId?: string): Promise<void> {
  const engine = await HeadlessEngine.open({
    cwd: process.cwd(),
    sessionId
  });

  let streamedAssistant = '';
  const maxWidth = Math.max(20, output.columns ?? 100);
  const activeSessionId = engine.snapshot.session.id;
  const initialTranscriptLength = engine.snapshot.transcript.length;
  const notebook = new Notebook(`${process.cwd()}/.h2/notebook.sqlite`);
  const initialHistoryLength = notebook.listModelHistory(activeSessionId).length;

  try {
    await engine.submit(prompt, {
      onAssistantStream: async (text) => {
        const delta = text.startsWith(streamedAssistant)
          ? text.slice(streamedAssistant.length)
          : text;
        if (delta) {
          output.write(truncatePrintLines(delta, maxWidth));
        }
        streamedAssistant = text;
      },
      onTranscriptEntry: async (role, text) => {
        if (role === 'user') {
          return;
        }

        if (role === 'assistant') {
          if (streamedAssistant) {
            if (text.startsWith(streamedAssistant)) {
              const suffix = text.slice(streamedAssistant.length);
              if (suffix) {
                output.write(truncatePrintLines(suffix, maxWidth));
              }
            } else if (text !== streamedAssistant) {
              output.write(`\n${truncatePrintLines(text, maxWidth)}`);
            }

            output.write('\n');
            streamedAssistant = '';
            return;
          }

          output.write(`${truncatePrintLines(text, maxWidth)}\n`);
          return;
        }

        if (streamedAssistant) {
          output.write('\n');
          streamedAssistant = '';
        }

        output.write(`${truncatePrintLines(`[${role}] ${text}`, maxWidth)}\n`);
      }
    });
  } finally {
    if (streamedAssistant) {
      output.write('\n');
    }
    const finalTranscript = engine.snapshot.transcript.slice(initialTranscriptLength);
    await engine.dispose();
    printPromptEvalSummary({
      sessionId: activeSessionId,
      historyItems: notebook.listModelHistory(activeSessionId).slice(initialHistoryLength),
      experiments: notebook.listExperiments(activeSessionId),
      transcript: finalTranscript,
      width: maxWidth
    });
    notebook.close();
  }
}

async function runAuthCommand(args: string[]): Promise<void> {
  const action = args[0];
  if (!action || !['login', 'status', 'access', 'logout'].includes(action)) {
    throw new Error('Usage: h2 auth <login|status|access|logout>');
  }

  const notebook = new Notebook(`${process.cwd()}/.h2/notebook.sqlite`);
  const auth = new OpenAICodexAuth(notebook, {
    notify: (message) => {
      console.log(message);
      console.log('');
    }
  });

  try {
    if (action === 'login') {
      console.log('Starting OpenAI Codex OAuth...');
      const record = await auth.authorize();
      console.log(`Login complete for account ${record.accountId || '(unknown)'}.`);
      console.log(`Expires: ${new Date(record.expiresAt).toISOString()}`);
      return;
    }

    if (action === 'status') {
      console.log(auth.formatStatus());
      return;
    }

    if (action === 'access') {
      const token = await auth.access();
      if (!token) {
        throw new Error('No active OpenAI Codex OAuth token is available.');
      }
      console.log(token);
      return;
    }

    console.log(
      auth.logout()
        ? 'OpenAI Codex OAuth credentials removed.'
        : 'No OpenAI Codex OAuth credentials were stored.'
    );
  } finally {
    notebook.close();
  }
}

function printDoctor(report: Awaited<ReturnType<typeof runDoctor>>): void {
  console.log(`h2 doctor`);
  console.log(`cwd: ${report.cwd}`);
  console.log('');

  for (const check of report.checks) {
    console.log(`${check.ok ? 'ok ' : 'no '} ${check.label}: ${check.detail}`);
  }
}

function parsePrintRequest(
  args: string[]
): { prompt: string; sessionId?: string } | null {
  if (args[0] === '-p' || args[0] === '--print') {
    const prompt = args.slice(1).join(' ').trim();
    if (!prompt) {
      throw new Error('Usage: h2 -p "<prompt>"');
    }
    return { prompt };
  }

  if (args[0] === 'resume' && args[1] && (args[2] === '-p' || args[2] === '--print')) {
    const prompt = args.slice(3).join(' ').trim();
    if (!prompt) {
      throw new Error('Usage: h2 resume <sessionId> -p "<prompt>"');
    }
    return {
      sessionId: args[1],
      prompt
    };
  }

  return null;
}

function truncatePrintLines(text: string, width: number): string {
  return text
    .split(/\r?\n/)
    .map((line) => truncateLine(line, width))
    .join('\n');
}

function truncateLine(line: string, width: number): string {
  if (line.length <= width) {
    return line;
  }

  if (width <= 1) {
    return line.slice(0, width);
  }

  return `${line.slice(0, width - 1)}…`;
}

function formatTranscriptEntry(role: 'user' | 'assistant' | 'tool' | 'system', text: string): string {
  const label =
    role === 'user'
      ? 'user'
      : role === 'assistant'
        ? 'assistant'
        : role === 'tool'
          ? 'tool'
          : 'system';
  return `[${label}] ${text}`;
}

function printPromptEvalSummary(input: {
  sessionId: string;
  historyItems: ModelHistoryItem[];
  experiments: ExperimentRecord[];
  transcript: TranscriptEntry[];
  width: number;
}): void {
  const spawnCalls = input.historyItems.filter(
    (item) => item.type === 'function_call' && item.name === 'spawn_experiment'
  ).length;
  const bashExperimentProbes = input.historyItems.filter(
    (item) =>
      item.type === 'function_call' &&
      item.name === 'bash' &&
      /ExperimentManager|spawned exp-|worktree|startSubagent|spawn\(/i.test(item.arguments)
  ).length;
  const assistantText = input.transcript
    .filter((entry) => entry.role === 'assistant')
    .map((entry) => entry.text)
    .join('\n\n');
  const claimedExperimentUse = /\b(spawn_experiment|used an experiment|used the experiment|ran an experiment|spawned an experiment|did end up using .*experiment)\b/i.test(
    assistantText
  );
  const lines = [
    '',
    '--- eval ---',
    `session: ${input.sessionId}`,
    `spawn_experiment calls: ${spawnCalls}`,
    `experiment rows created: ${input.experiments.length}`
  ];

  if (input.experiments.length > 0) {
    lines.push(
      ...input.experiments.map(
        (experiment) => `  - ${experiment.id} ${experiment.status} ${experiment.hypothesis}`
      )
    );
  }

  if (bashExperimentProbes > 0) {
    lines.push(`bash experiment-like probes: ${bashExperimentProbes}`);
  }

  lines.push(`assistant claimed experiment use: ${claimedExperimentUse ? 'yes' : 'no'}`);

  if (claimedExperimentUse && spawnCalls === 0 && input.experiments.length === 0) {
    lines.push('mismatch: assistant claimed experiment use, but no real experiment was recorded');
  }

  output.write(`${truncatePrintLines(lines.join('\n'), input.width)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
