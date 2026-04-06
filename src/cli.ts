#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';

import { OpenAICodexAuth } from './auth/openai-codex.js';
import { runDoctor } from './commands/doctor.js';
import { HeadlessEngine } from './engine/headless-engine.js';
import { Notebook } from './storage/notebook.js';
import { HarnessApp } from './ui/app.js';

async function main(): Promise<void> {
  const [, , ...args] = process.argv;
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

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
