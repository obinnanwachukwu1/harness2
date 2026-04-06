# harness2

`harness2` is a small experimental coding harness that proves one vertical slice:

- a headless main engine owns transcript state and tool execution
- a scoped experiment runs in an isolated `git worktree`
- experiment state is persisted in SQLite
- an Ink terminal UI renders the transcript, experiments, status bar, and composer
- normal user text can now route to a Codex model over OAuth and call the local tool surface

This is intentionally v0.1. There is no model backend yet, no plugins, and no parallel experiments.

## Requirements

- Node 22+
- a Git repository with at least one commit in the current working directory

## Run

```bash
npm install
npm run dev
```

Useful commands:

```bash
npm run dev -- doctor
npm run dev -- auth login
npm run dev -- auth status
npm run dev -- auth access
npm run dev -- auth logout
npm run dev -- resume <sessionId>
```

Build and test:

```bash
npm run build
npm test
```

## Interactive commands

Inside the terminal UI, use slash commands:

```text
/help
/bash git status --short
/read package.json
/write scratch.txt :: hello
/edit scratch.txt :: hello => hello world
/glob "src/**/*.ts"
/grep HeadlessEngine src
/spawn --hypothesis "node is available in isolation" --cmd "node --version"
/experiment exp-12345678
/auth login
/auth status
/auth logout
/quit
```

Any non-slash input is sent to the Codex model when OAuth is configured. The model can use the built-in local tools (`bash`, `read`, `write`, `edit`, `glob`, `grep`, `spawn_experiment`, `read_experiment`) through the headless engine.

## OpenAI Codex OAuth

The prototype now includes a direct OpenAI Codex OAuth flow for local testing.

- `h2 auth login` starts a browser-based PKCE flow against `https://auth.openai.com`
- tokens are stored in `.h2/notebook.sqlite`
- `h2 auth access` prints a refreshed bearer token to stdout for manual API testing
- `/auth login`, `/auth status`, and `/auth logout` are also available inside the Ink UI
- once logged in, plain text in the interactive app is sent to the Codex backend using the stored OAuth token

Notes:

- the callback server listens on `127.0.0.1:1455` by default
- if the browser does not open, the CLI prints the authorization URL
- token refresh happens automatically when expiry is within five minutes
- the interactive UI does not print the raw bearer token into the transcript

## Layout

```text
src/
  cli.ts
  commands/doctor.ts
  engine/
  experiments/
  storage/
  ui/
test/
```

## Notes

- State lives under `.h2/notebook.sqlite`.
- Experiment worktrees live under `.h2/worktrees/<experimentId>`.
- Resolved experiments remove their worktree unless `--preserve` is set.
- Token usage is currently a simple estimated counter based on emitted observation text.
- Model integration, cancellation, and richer editing commands are left as TODOs for later versions.
