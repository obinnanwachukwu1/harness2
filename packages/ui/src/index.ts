import { App } from './App.js';

const args = process.argv.slice(2);
let cwd = process.cwd();
let sessionId: string | undefined;
let mode: 'study' | 'plan' | 'direct' | undefined;

for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (value === '--cwd' && args[index + 1]) {
    cwd = args[index + 1]!;
    index += 1;
    continue;
  }

  if (value === '--session' && args[index + 1]) {
    sessionId = args[index + 1]!;
    index += 1;
    continue;
  }

  if (value === '--mode' && args[index + 1]) {
    const next = args[index + 1]!;
    if (next === 'study' || next === 'plan' || next === 'direct') {
      mode = next;
      index += 1;
    }
  }
}

const app = await App.open({ cwd, sessionId, mode });
await app.run();
