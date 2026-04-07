#!/usr/bin/env node
import path from 'node:path';
import { stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

import type { ExperimentRecord, ModelHistoryItem, TranscriptEntry } from './types.js';

async function main(): Promise<void> {
  const [, , ...args] = process.argv;
  const printRequest = parsePrintRequest(args);
  if (printRequest) {
    await runPrintMode(printRequest.prompt, printRequest.sessionId, printRequest.thinking);
    return;
  }

  const command = args[0];

  if (command === 'doctor') {
    const { runDoctor } = await import('./commands/doctor.js');
    const report = await runDoctor(process.cwd());
    printDoctor(report);
    if (!report.healthy) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'opentui') {
    await runOpenTui(args[1]);
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
  await runOpenTui(sessionId);
}

async function runOpenTui(sessionId?: string): Promise<void> {
  const repoRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
  const entryPath = path.join(repoRoot, 'packages/ui-opentui-spike/src/index.ts');
  const args = ['run', entryPath, '--cwd', process.cwd()];
  if (sessionId) {
    args.push('--session', sessionId);
  }

  await execa('bun', args, {
    cwd: repoRoot,
    stdio: 'inherit'
  });
}

async function runPrintMode(
  prompt: string,
  sessionId?: string,
  thinking = true
): Promise<void> {
  const { HeadlessEngine } = await import('./engine/headless-engine.js');
  const { Notebook } = await import('./storage/notebook.js');
  const engine = await HeadlessEngine.open({
    cwd: process.cwd(),
    sessionId
  });
  engine.setThinkingEnabled(thinking);

  let streamedAssistant = '';
  let pendingThinking = '';
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
      onReasoningSummaryStream: async (text) => {
        pendingThinking = `[thinking] ${normalizeReasoningSummaryText(text)}`;
      },
      onTranscriptEntry: async (role, text) => {
        if (role === 'user') {
          return;
        }

        if (role !== 'system' && pendingThinking) {
          output.write(`${truncatePrintLines(pendingThinking, maxWidth)}\n`);
          pendingThinking = '';
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

        output.write(`${truncatePrintLines(formatTranscriptEntry(role, text), maxWidth)}\n`);
      }
    });
  } finally {
    if (streamedAssistant) {
      output.write('\n');
    }
    if (pendingThinking) {
      output.write(`${truncatePrintLines(pendingThinking, maxWidth)}\n`);
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
  const { Notebook } = await import('./storage/notebook.js');
  const { OpenAICodexAuth } = await import('./auth/openai-codex.js');
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

function printDoctor(report: {
  cwd: string;
  healthy: boolean;
  checks: Array<{ ok: boolean; label: string; detail: string }>;
}): void {
  console.log(`h2 doctor`);
  console.log(`cwd: ${report.cwd}`);
  console.log('');

  for (const check of report.checks) {
    console.log(`${check.ok ? 'ok ' : 'no '} ${check.label}: ${check.detail}`);
  }
}

function parsePrintRequest(
  args: string[]
): { prompt: string; sessionId?: string; thinking: boolean } | null {
  if (args[0] === '-p' || args[0] === '--print' || args[0] === '-thinking' || args[0] === '-no-thinking') {
    const thinking = !args.includes('-no-thinking');
    const printIndex = args.findIndex((arg) => arg === '-p' || arg === '--print');
    if (printIndex === -1) {
      throw new Error('Usage: h2 [-thinking|-no-thinking] -p "<prompt>"');
    }

    const prompt = args.slice(printIndex + 1).join(' ').trim();
    if (!prompt) {
      throw new Error('Usage: h2 [-thinking|-no-thinking] -p "<prompt>"');
    }
    return { prompt, thinking };
  }

  if (args[0] === 'resume' && args[1] && args.slice(2).some((arg) => arg === '-p' || arg === '--print')) {
    const thinking = !args.slice(2).includes('-no-thinking');
    const printIndex = args.findIndex((arg, index) => index >= 2 && (arg === '-p' || arg === '--print'));
    const prompt = args.slice(printIndex + 1).join(' ').trim();
    if (!prompt) {
      throw new Error('Usage: h2 resume <sessionId> [-thinking|-no-thinking] -p "<prompt>"');
    }
    return {
      sessionId: args[1],
      prompt,
      thinking
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

function normalizeReasoningSummaryText(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
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
  if (role === 'system' && text.startsWith('@@thinking\t')) {
    return `[thinking] ${text.slice('@@thinking\t'.length)}`;
  }
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
