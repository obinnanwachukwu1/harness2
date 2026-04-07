import { OpenTuiApp } from './OpenTuiApp.js';

const args = process.argv.slice(2);
let cwd = process.cwd();
let sessionId: string | undefined;

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
  }
}

const app = await OpenTuiApp.open({ cwd, sessionId });
await app.run();
