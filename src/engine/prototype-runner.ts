import type {
  AgentRunContext,
  ExperimentAdoptionPreview,
  ExperimentAdoptionResult,
  ExperimentDetails
} from '../types.js';

const HELP_TEXT = [
  'Commands:',
  '/help',
  '/export [sessionId]',
  '/clear-journal [--force]',
  '/auth login',
  '/auth status',
  '/auth logout',
  '/model',
  '/model <name>',
  '/reasoning <off|low|medium|high>',
  '/thinking [on|off]',
  '/quit'
].join('\n');

export class PrototypeRunner {
  async runTurn(input: string, context: AgentRunContext): Promise<void> {
    const trimmed = input.trim();

    if (!trimmed) {
      return;
    }

    if (!trimmed.startsWith('/')) {
      await context.runModel(trimmed);
      return;
    }

    const [command, ...rawArgs] = tokenize(trimmed);
    const commandName = command.slice(1);

    switch (commandName) {
      case 'help': {
        await context.emit('assistant', HELP_TEXT);
        return;
      }

      case 'clear-journal': {
        if (!context.tools.clearExperimentJournal) {
          await context.emit('assistant', 'Experiment journal clearing is not available.');
          return;
        }

        const result = await context.tools.clearExperimentJournal(rawArgs.includes('--force'));
        if (result.blockedActive > 0) {
          await context.emit(
            'assistant',
            `Refusing to clear the journal because ${result.blockedActive} active experiment(s) still exist. Re-run /clear-journal --force if you really want to remove them.`
          );
          return;
        }

        await context.emit(
          'assistant',
          `Cleared ${result.clearedExperiments} experiment(s) and ${result.clearedObservations} observation(s) from the current session journal.`
        );
        return;
      }

      case 'export': {
        if (!context.tools.exportSession) {
          await context.emit('assistant', 'Session export is not available.');
          return;
        }

        const sessionId = rawArgs[0];
        const result = await context.tools.exportSession(sessionId);
        await context.emit(
          'assistant',
          result.revealedInFinder
            ? `Exported ${result.sessionId} to ${result.exportPath} and revealed it in Finder.`
            : `Exported ${result.sessionId} to ${result.exportPath}.`
        );
        return;
      }

      case 'auth': {
        const subcommand = rawArgs[0];
        if (subcommand === 'login') {
          await context.emit('assistant', 'Starting OpenAI Codex OAuth in your browser.');
          const output = await context.tools.authLogin();
          await context.emit('assistant', output);
          return;
        }

        if (subcommand === 'status') {
          const output = await context.tools.authStatus();
          await context.emit('assistant', output);
          return;
        }

        if (subcommand === 'logout') {
          const output = await context.tools.authLogout();
          await context.emit('assistant', output);
          return;
        }

        await context.emit('assistant', 'Usage: /auth <login|status|logout>');
        return;
      }

      case 'model': {
        const modelName = rawArgs[0];
        const output = modelName
          ? await context.tools.setModel(modelName)
          : await context.tools.getModelSettings();
        await context.emit('assistant', output);
        return;
      }

      case 'reasoning': {
        const effort = rawArgs[0];
        if (!effort || !['off', 'low', 'medium', 'high'].includes(effort)) {
          await context.emit('assistant', 'Usage: /reasoning <off|low|medium|high>');
          return;
        }

        const output = await context.tools.setReasoningEffort(
          effort as 'off' | 'low' | 'medium' | 'high'
        );
        await context.emit('assistant', output);
        return;
      }

      case 'thinking': {
        const value = rawArgs[0];
        if (!value) {
          const output = await context.tools.getThinkingMode();
          await context.emit('assistant', output);
          return;
        }

        if (!['on', 'off'].includes(value)) {
          await context.emit('assistant', 'Usage: /thinking [on|off]');
          return;
        }

        const output = await context.tools.setThinkingMode(value === 'on');
        await context.emit('assistant', output);
        return;
      }

      default: {
        await context.emit(
          'assistant',
          `Unknown command: ${commandName}\n\nUse /help to see the supported commands.`
        );
      }
    }
  }
}

function tokenize(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map(stripQuotes);
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseFlags(tokens: string[]): Map<string, string> {
  const flags = new Map<string, string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = tokens[index + 1];

    if (!next || next.startsWith('--')) {
      flags.set(key, 'true');
      continue;
    }

    flags.set(key, next);
    index += 1;
  }

  return flags;
}

function formatExperiment(details: ExperimentDetails): string {
  const header = [
    `Experiment ${details.id}`,
    `status: ${details.status}`,
    `hypothesis: ${details.hypothesis}`,
    `base: ${details.baseCommitSha}`,
    `worktree: ${details.worktreePath}`,
    `budget: ${details.tokensUsed}/${details.budget} estimated tokens`,
    `budget_breakdown: context ${details.contextTokensUsed}, tool_output ${details.toolOutputTokensUsed}, observations ${details.observationTokensUsed}`
  ];

  if (details.promote) {
    header.push('promote: true');
  }

  if (details.finalSummary) {
    header.push(`summary: ${details.finalSummary}`);
  }

  if (details.discovered.length > 0) {
    header.push(`discovered: ${details.discovered.join(' | ')}`);
  }

  if (details.artifacts.length > 0) {
    header.push(`artifacts: ${details.artifacts.join(' | ')}`);
  }

  if (details.constraints.length > 0) {
    header.push(`constraints: ${details.constraints.join(' | ')}`);
  }

  if (details.confidenceNote) {
    header.push(`confidence: ${details.confidenceNote}`);
  }

  if (details.lowSignalWarningEmitted) {
    header.push('quality: low-signal warning emitted');
  }

  const observations = details.observations
    .slice(-10)
    .map((entry) => {
      const tags = entry.tags.length > 0 ? ` ${entry.tags.map((tag) => `#${tag}`).join(' ')}` : '';
      return `[${entry.createdAt}]${tags}\n${entry.message}`;
    })
    .join('\n\n');

  return observations ? `${header.join('\n')}\n\n${observations}` : header.join('\n');
}

function formatAdoption(result: ExperimentAdoptionPreview | ExperimentAdoptionResult): string {
  const applied = 'appliedAt' in result;
  const lines = [
    applied ? 'Experiment adoption applied' : 'Experiment adoption preview',
    `id: ${result.experimentId}`,
    `branch: ${result.branchName}`,
    `base: ${result.baseCommitSha}`,
    `worktree: ${result.worktreePath}`,
    `patch: ${result.patchPath}`,
    `rollback: ${result.rollbackBranchName}`,
    `applyable: ${result.applyable ? 'yes' : 'no'}`,
    result.changedFiles.length > 0
      ? `changed_files: ${result.changedFiles.join(' | ')}`
      : 'changed_files: none',
    result.untrackedFiles.length > 0
      ? `untracked_files: ${result.untrackedFiles.join(' | ')}`
      : null,
    'diff_stat:',
    result.diffStat
  ].filter((line): line is string => Boolean(line));

  if (!applied) {
    lines.push('', `Run /adopt ${result.experimentId} --apply to apply this patch.`);
  } else {
    lines.push('', `Applied at: ${result.appliedAt}`);
  }

  return lines.join('\n');
}
