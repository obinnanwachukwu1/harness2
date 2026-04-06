import { DEFAULT_EXPERIMENT_BUDGET_TOKENS } from '../lib/utils.js';
import type {
  AgentRunContext,
  ExperimentAdoptionPreview,
  ExperimentAdoptionResult,
  ExperimentDetails
} from '../types.js';

const HELP_TEXT = [
  'Commands:',
  '/help',
  '/bash <command...>',
  '/read <path> [startLine] [endLine]',
  '/write <path> :: <content>',
  '/edit <path> :: <find> => <replace>',
  '/glob <pattern>',
  '/grep <pattern> [path]',
  `/spawn --hypothesis "..." [--budget ${DEFAULT_EXPERIMENT_BUDGET_TOKENS}] [--context "..."] [--preserve]`,
  '/experiment <experimentId>',
  '/adopt <experimentId> [--apply]',
  '/experiment-budget <experimentId> <additionalTokens>',
  '/experiments [query]',
  '/auth login',
  '/auth status',
  '/auth logout',
  '/model',
  '/model <name>',
  '/reasoning <off|low|medium|high>',
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

      case 'bash': {
        const commandText = trimmed.replace(/^\/bash\s+/, '');
        if (!commandText || commandText === trimmed) {
          await context.emit('assistant', 'Usage: /bash <command...>');
          return;
        }

        const output = await context.tools.bash(commandText);
        await context.emit('tool', output);
        return;
      }

      case 'read': {
        const filePath = rawArgs[0];
        if (!filePath) {
          await context.emit('assistant', 'Usage: /read <path> [startLine] [endLine]');
          return;
        }

        const startLine = rawArgs[1] ? Number.parseInt(rawArgs[1], 10) : undefined;
        const endLine = rawArgs[2] ? Number.parseInt(rawArgs[2], 10) : undefined;
        if (
          (rawArgs[1] && Number.isNaN(startLine)) ||
          (rawArgs[2] && Number.isNaN(endLine)) ||
          (startLine !== undefined && startLine < 1) ||
          (endLine !== undefined && endLine < 1)
        ) {
          await context.emit('assistant', 'Usage: /read <path> [startLine] [endLine]');
          return;
        }

        const output = await context.tools.read(filePath, startLine, endLine);
        await context.emit('tool', output);
        return;
      }

      case 'write': {
        const payload = trimmed.replace(/^\/write\s+/, '');
        const divider = payload.indexOf('::');
        if (divider === -1) {
          await context.emit('assistant', 'Usage: /write <path> :: <content>');
          return;
        }

        const filePath = payload.slice(0, divider).trim();
        const content = payload.slice(divider + 2).trimStart();
        const output = await context.tools.write(filePath, content);
        await context.emit('tool', output);
        return;
      }

      case 'edit': {
        const payload = trimmed.replace(/^\/edit\s+/, '');
        const divider = payload.indexOf('::');
        if (divider === -1) {
          await context.emit('assistant', 'Usage: /edit <path> :: <find> => <replace>');
          return;
        }

        const filePath = payload.slice(0, divider).trim();
        const remainder = payload.slice(divider + 2).trimStart();
        const replacementDivider = remainder.indexOf('=>');
        if (replacementDivider === -1) {
          await context.emit('assistant', 'Usage: /edit <path> :: <find> => <replace>');
          return;
        }

        const findText = remainder.slice(0, replacementDivider).trim();
        const replaceText = remainder.slice(replacementDivider + 2).trim();
        const output = await context.tools.edit(filePath, findText, replaceText);
        await context.emit('tool', output);
        return;
      }

      case 'glob': {
        const pattern = rawArgs[0];
        if (!pattern) {
          await context.emit('assistant', 'Usage: /glob <pattern>');
          return;
        }

        const matches = await context.tools.glob(pattern);
        await context.emit(
          'tool',
          matches.length > 0 ? matches.join('\n') : `No files matched ${pattern}.`
        );
        return;
      }

      case 'grep': {
        const pattern = rawArgs[0];
        const target = rawArgs[1];
        if (!pattern) {
          await context.emit('assistant', 'Usage: /grep <pattern> [path]');
          return;
        }

        const output = await context.tools.grep(pattern, target);
        await context.emit('tool', output);
        return;
      }

      case 'spawn': {
        const flags = parseFlags(rawArgs);
        const hypothesis = flags.get('hypothesis');

        if (!hypothesis) {
          await context.emit(
            'assistant',
            `Usage: /spawn --hypothesis "..." [--budget ${DEFAULT_EXPERIMENT_BUDGET_TOKENS}] [--context "..."] [--preserve]`
          );
          return;
        }

        const budgetValue = flags.get('budget');
        const budget = budgetValue
          ? Number.parseInt(budgetValue, 10)
          : DEFAULT_EXPERIMENT_BUDGET_TOKENS;
        if (Number.isNaN(budget) || budget < 1) {
          await context.emit('assistant', 'Budget must be a positive integer.');
          return;
        }

        const experiment = await context.tools.spawnExperiment({
          hypothesis,
          context: flags.get('context'),
          budgetTokens: budget,
          preserve: flags.has('preserve')
        });

        await context.emit(
          'assistant',
          `Spawned ${experiment.id} from ${experiment.baseCommitSha.slice(0, 8)} in ${experiment.worktreePath}.`
        );
        return;
      }

      case 'experiment': {
        const experimentId = rawArgs[0];
        if (!experimentId) {
          await context.emit('assistant', 'Usage: /experiment <experimentId>');
          return;
        }

        const details = await context.tools.readExperiment(experimentId);
        await context.emit('assistant', formatExperiment(details));
        return;
      }

      case 'adopt': {
        const experimentId = rawArgs.find((token) => !token.startsWith('--'));
        if (!experimentId) {
          await context.emit('assistant', 'Usage: /adopt <experimentId> [--apply]');
          return;
        }

        if (!context.tools.adoptExperiment) {
          await context.emit('assistant', 'Experiment adoption is not available.');
          return;
        }

        const result = await context.tools.adoptExperiment(experimentId, {
          apply: rawArgs.includes('--apply')
        });
        await context.emit('assistant', formatAdoption(result));
        return;
      }

      case 'experiment-budget': {
        const experimentId = rawArgs[0];
        const additionalValue = rawArgs[1];
        if (!experimentId || !additionalValue) {
          await context.emit('assistant', 'Usage: /experiment-budget <experimentId> <additionalTokens>');
          return;
        }

        if (!context.tools.extendExperimentBudget) {
          await context.emit('assistant', 'Experiment budget extension is not available.');
          return;
        }

        const additionalTokens = Number.parseInt(additionalValue, 10);
        if (Number.isNaN(additionalTokens) || additionalTokens < 1) {
          await context.emit('assistant', 'additionalTokens must be a positive integer.');
          return;
        }

        const experiment = await context.tools.extendExperimentBudget(
          experimentId,
          additionalTokens
        );
        await context.emit(
          'assistant',
          `Extended ${experiment.id} by ${additionalTokens} estimated tokens. New budget: ${experiment.budget}.`
        );
        return;
      }

      case 'experiments': {
        if (!context.tools.searchExperiments) {
          await context.emit('assistant', 'Experiment search is not available.');
          return;
        }

        const query = rawArgs.join(' ').trim();
        const matches = await context.tools.searchExperiments(query || undefined);
        if (matches.length === 0) {
          await context.emit('assistant', query ? `No experiments matched "${query}".` : 'No experiments found.');
          return;
        }

        const lines = matches.slice(0, 10).map((experiment) => {
          const summary = experiment.summary || experiment.hypothesis;
          return `${experiment.experimentId}  ${experiment.status}  ${summary}`;
        });
        await context.emit('assistant', lines.join('\n'));
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
