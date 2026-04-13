import type { AgentRunContext } from '../types.js';

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
