#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import process, { stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

import type { ExperimentRecord, ModelHistoryItem, SessionRecord, TranscriptEntry } from './types.js';
import { describeStatePaths, getRepoNotebookPath } from './state-paths.js';

class CliUsageError extends Error {}

async function main(): Promise<void> {
  const [, , ...args] = process.argv;
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    return;
  }

  const printRequest = parsePrintRequest(args);
  if (printRequest) {
    assertSupportedNodeRuntime();
    await assertInsideGitRepository(process.cwd());
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
    assertSupportedNodeRuntime();
    await assertInsideGitRepository(process.cwd());
    await runOpenTui(args[1]);
    return;
  }

  if (command === 'auth') {
    await runAuthCommand(args.slice(1));
    return;
  }

  if (command === 'paths') {
    printStatePaths(process.cwd());
    return;
  }

  if (command === 'eval') {
    assertSupportedNodeRuntime();
    await runEvalCommand(args.slice(1));
    return;
  }

  const sessionId = command === 'resume' ? args[1] : undefined;
  if (command === 'resume' && !sessionId) {
    await assertInsideGitRepository(process.cwd());
    await printRecentSessions(process.cwd());
    return;
  }

  if (command && command !== 'resume') {
    throw new CliUsageError(`Unknown command: ${command}`);
  }
  assertSupportedNodeRuntime();
  await assertInsideGitRepository(process.cwd());
  await runOpenTui(sessionId);
}

async function runOpenTui(sessionId?: string): Promise<void> {
  await assertKnownSession(process.cwd(), sessionId);
  const repoRoot = resolveHarnessRoot();
  const entryPath = path.join(repoRoot, 'packages/ui-opentui/src/index.ts');
  await assertBunAvailable();
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
  const initialHistoryLength = engine.notebook.listModelHistory(activeSessionId).length;

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
    printPromptEvalSummary({
      sessionId: activeSessionId,
      historyItems: engine.notebook.listModelHistory(activeSessionId).slice(initialHistoryLength),
      experiments: engine.notebook.listExperiments(activeSessionId),
      transcript: finalTranscript,
      width: maxWidth
    });
    await engine.dispose();
  }
}

async function runAuthCommand(args: string[]): Promise<void> {
  const { Notebook } = await import('./storage/notebook.js');
  const { OpenAICodexAuth } = await import('./auth/openai-codex.js');
  const {
    migrateLegacyRepoLocalAuth,
    openGlobalAuthNotebook
  } = await import('./auth/storage.js');
  const action = args[0];
  if (!action || !['login', 'status', 'access', 'logout'].includes(action)) {
    throw new CliUsageError('Usage: h2 auth <login|status|access|logout>');
  }

  const repoNotebook = new Notebook(getRepoNotebookPath(process.cwd()));
  const authNotebook = openGlobalAuthNotebook();
  migrateLegacyRepoLocalAuth(repoNotebook, authNotebook);
  const auth = new OpenAICodexAuth(authNotebook, {
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
      console.log('');
      printStatePaths(process.cwd());
      return;
    }

    if (action === 'access') {
      const token = await auth.access();
      if (!token) {
        throw new Error('No active OpenAI Codex OAuth token is available. Run `h2 auth login` first.');
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
    repoNotebook.close();
    authNotebook.close();
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

  console.log('');
  printStatePaths(report.cwd);
}

function printUsage(): void {
  console.log('Usage: h2 [resume [sessionId]] [opentui] | h2 auth <login|status|access|logout> | h2 doctor | h2 paths | h2 eval run <manifest> [--case <id>] | h2 eval score <run-dir>');
  console.log('');
  console.log('Examples:');
  console.log('h2');
  console.log('h2 -p "inspect the repo"');
  console.log('h2 resume');
  console.log('h2 resume <sessionId>');
  console.log('h2 auth login');
  console.log('h2 doctor');
  console.log('h2 eval run evals/core-suite.toml --case A1');
  console.log('h2 eval score ~/.h2/evals/<run-id>');
}

async function runEvalCommand(args: string[]): Promise<void> {
  const action = args[0];
  if (action !== 'run' && action !== 'score') {
    throw new CliUsageError('Usage: h2 eval run <manifest> [--case <id>] | h2 eval score <run-dir>');
  }

  if (action === 'score') {
    const runDir = args[1];
    if (!runDir) {
      throw new CliUsageError('Usage: h2 eval score <run-dir>');
    }
    const { scoreEvalRun } = await import('./evals/score-run.js');
    const result = await scoreEvalRun(path.resolve(runDir));
    console.log(`score sheet: ${result.scoreSheetCsvPath}`);
    console.log(`score data: ${result.scoreSheetJsonPath}`);
    console.log('');
    for (const score of result.scores) {
      console.log(`${score.testId}  overall=${score.overall}  question=${score.questionActual ? 'yes' : 'no'}  experiments=${score.experimentActual}`);
    }
    return;
  }

  const manifestPath = args[1];
  if (!manifestPath) {
    throw new CliUsageError('Usage: h2 eval run <manifest> [--case <id>]');
  }

  const selectedCaseIds: string[] = [];
  for (let index = 2; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--case') {
      const caseId = args[index + 1];
      if (!caseId) {
        throw new CliUsageError('Usage: h2 eval run <manifest> [--case <id>]');
      }
      selectedCaseIds.push(caseId);
      index += 1;
      continue;
    }
    throw new CliUsageError(`Unknown eval argument: ${token}`);
  }

  const { runEvalSuite } = await import('./evals/suite-runner.js');
  const result = await runEvalSuite({
    manifestPath,
    selectedCaseIds: selectedCaseIds.length > 0 ? selectedCaseIds : undefined
  });

  console.log(`eval run: ${result.runId}`);
  console.log(`suite: ${result.suiteId}`);
  console.log(`results: ${path.dirname(result.lockedManifestPath)}`);
  console.log('');
  for (const caseResult of result.cases) {
    console.log(
      `${caseResult.caseId}  session=${caseResult.sessionId}  question=${caseResult.autoScore.questionActual ? 'yes' : 'no'}  experiments=${caseResult.autoScore.experimentActual}`
    );
  }
}

function printStatePaths(cwd: string): void {
  for (const entry of describeStatePaths(cwd)) {
    console.log(`${entry.label}: ${entry.path}`);
  }
}

function parsePrintRequest(
  args: string[]
): { prompt: string; sessionId?: string; thinking: boolean } | null {
  if (args[0] === '-p' || args[0] === '--print' || args[0] === '-thinking' || args[0] === '-no-thinking') {
    const thinking = !args.includes('-no-thinking');
    const printIndex = args.findIndex((arg) => arg === '-p' || arg === '--print');
    if (printIndex === -1) {
      throw new CliUsageError('Usage: h2 [-thinking|-no-thinking] -p "<prompt>"');
    }

    const prompt = args.slice(printIndex + 1).join(' ').trim();
    if (!prompt) {
      throw new CliUsageError('Usage: h2 [-thinking|-no-thinking] -p "<prompt>"');
    }
    return { prompt, thinking };
  }

  if (args[0] === 'resume' && args[1] && args.slice(2).some((arg) => arg === '-p' || arg === '--print')) {
    const thinking = !args.slice(2).includes('-no-thinking');
    const printIndex = args.findIndex((arg, index) => index >= 2 && (arg === '-p' || arg === '--print'));
    const prompt = args.slice(printIndex + 1).join(' ').trim();
    if (!prompt) {
      throw new CliUsageError('Usage: h2 resume <sessionId> [-thinking|-no-thinking] -p "<prompt>"');
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
  const inlineExperimentProbes = input.historyItems.filter(
    (item) =>
      item.type === 'function_call' &&
      item.name === 'exec_command' &&
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

  if (inlineExperimentProbes > 0) {
    lines.push(`exec_command experiment-like probes: ${inlineExperimentProbes}`);
  }

  lines.push(`assistant claimed experiment use: ${claimedExperimentUse ? 'yes' : 'no'}`);

  if (claimedExperimentUse && spawnCalls === 0 && input.experiments.length === 0) {
    lines.push('mismatch: assistant claimed experiment use, but no real experiment was recorded');
  }

  output.write(`${truncatePrintLines(lines.join('\n'), input.width)}\n`);
}

function assertSupportedNodeRuntime(): void {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (nodeMajor < 22) {
    throw new Error(`Node ${process.version} is not supported. Use Node 22 or newer.`);
  }
}

async function assertInsideGitRepository(cwd: string): Promise<void> {
  const repoResult = await execa('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    reject: false
  });

  if (repoResult.exitCode !== 0 || repoResult.stdout.trim() !== 'true') {
    throw new Error(
      'h2 must run inside a Git repository with at least one commit. Run `git init` and make an initial commit, or change into an existing repo.'
    );
  }

  const headResult = await execa('git', ['rev-parse', 'HEAD'], {
    cwd,
    reject: false
  });
  if (headResult.exitCode === 0) {
    return;
  }

  throw new Error(
    'h2 requires a Git repository with at least one commit. Create an initial commit, then retry.'
  );
}

async function assertKnownSession(cwd: string, sessionId?: string): Promise<void> {
  if (!sessionId) {
    return;
  }

  const { Notebook } = await import('./storage/notebook.js');
  const notebook = new Notebook(getRepoNotebookPath(cwd));
  try {
    if (notebook.getSession(sessionId)) {
      return;
    }

    const recentSessions = notebook.listRecentSessions(10);
    const recentSummary =
      recentSessions.length > 0
        ? `\n\nRecent sessions in this repo:\n${formatSessionList(recentSessions)}`
        : '\n\nNo saved sessions were found in this repo.';

    throw new Error(
      `Unknown session: ${sessionId}. Sessions are stored per repository, so run \`h2 resume ${sessionId}\` from the repo where that session was created.${recentSummary}`
    );
  } finally {
    notebook.close();
  }
}

async function printRecentSessions(cwd: string): Promise<void> {
  const { Notebook } = await import('./storage/notebook.js');
  const notebook = new Notebook(getRepoNotebookPath(cwd));

  try {
    const recentSessions = notebook.listRecentSessions(10);
    if (recentSessions.length === 0) {
      console.log('No saved sessions in this repo yet.');
      console.log('Start one with `h2` or `h2 -p "<prompt>"`.');
      return;
    }

    console.log(`Recent sessions for ${cwd}:`);
    console.log('');
    console.log(formatSessionList(recentSessions));
    console.log('');
    console.log('Resume one with `h2 resume <sessionId>`.');
  } finally {
    notebook.close();
  }
}

function formatSessionList(sessions: SessionRecord[]): string {
  return sessions
    .map(
      (session) =>
        `${session.id}  last active ${session.lastActiveAt}  started ${session.startedAt}`
    )
    .join('\n');
}

async function assertBunAvailable(): Promise<void> {
  const result = await execa('bun', ['--version'], {
    reject: false
  });

  if (result.exitCode === 0) {
    return;
  }

  throw new Error(
    'OpenTUI currently requires Bun because @opentui/core imports bun:ffi. Install Bun, or use print mode (`h2 -p "..."`) for a Node-only path.'
  );
}

function resolveHarnessRoot(): string {
  const candidates = [
    path.resolve(fileURLToPath(new URL('../', import.meta.url))),
    path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
  ];

  for (const candidate of candidates) {
    const uiEntry = path.join(candidate, 'packages/ui-opentui/src/index.ts');
    if (existsSync(uiEntry)) {
      return candidate;
    }
  }

  return candidates[0]!;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CliUsageError) {
    console.error(message);
    console.error('');
    printUsage();
  } else {
    console.error(`error: ${message}`);
    console.error('Run `h2 help` for usage or `h2 doctor` to check the local setup.');
  }
  process.exitCode = 1;
});
