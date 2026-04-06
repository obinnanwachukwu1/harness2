#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';

import { runDoctor } from './commands/doctor.js';
import { HeadlessEngine } from './engine/headless-engine.js';
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
