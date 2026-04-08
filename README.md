# harness2

`harness2` is a small experimental coding harness that proves one vertical slice:

- a headless main engine owns transcript state and tool execution
- a scoped experiment runs in an isolated `git worktree`
- experiment state is persisted in SQLite
- an OpenTUI terminal UI renders the transcript, experiments, status bar, and composer
- normal user text can now route to a Codex model over OAuth and call the local tool surface

This is still intentionally v0.1. The core vertical slice works, but the harness is still evolving and some UX and tooling edges remain rough.

## Requirements

- Node 22+
- a Git repository with at least one commit in the current working directory

## Run

```bash
npm install
npm run dev
```

`npm run dev` now launches the OpenTUI frontend by default.

Useful commands:

```bash
npm run dev -- doctor
npm run dev -- auth login
npm run dev -- auth status
npm run dev -- auth access
npm run dev -- auth logout
npm run dev -- -p "inspect the repo"
npm run dev -- -thinking -p "inspect the repo"
npm run dev -- resume <sessionId> -p "continue from here"
npm run dev -- resume <sessionId> -thinking -p "continue from here"
npm run dev -- resume <sessionId>
npm run dev -- opentui
npm run dev -- opentui <sessionId>
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
/read package.json 120 180
/write scratch.txt :: hello
/edit <patch>
/glob "src/**/*.ts"
/grep HeadlessEngine src
/spawn --hypothesis "node is available in isolation"
/experiment exp-12345678
/adopt exp-12345678
/auth login
/auth status
/auth logout
/thinking on
/thinking off
/quit
```

`/edit` expects the same patch grammar the model uses:

```text
*** Begin Patch
*** Update File: scratch.txt
@@
-hello
+hello world
*** End Patch
```

Any non-slash input is sent to the Codex model when OAuth is configured. The model can use the built-in local tools (`bash`, `read`, `write`, `edit`, `glob`, `grep`, `spawn_experiment`, `read_experiment`, `wait_experiment`, `search_experiments`, `compact`) through the headless engine.

## Prompt Mode

For a noninteractive one-shot mode with streamed output, use:

```bash
npm run dev -- -p "what does this project do?"
npm run dev -- -thinking -p "what does this project do?"
npm run dev -- resume <sessionId> -p "continue the previous investigation"
npm run dev -- resume <sessionId> -thinking -p "continue the previous investigation"
```

This runs a single turn through the normal engine path and prints streamed assistant text and tool outputs directly to stdout.

To debug raw model response shapes:

```bash
H2_DEBUG_RESPONSES=1 npm run dev -- -p "inspect the repo"
```

This writes JSONL debug records to `.h2/debug/responses.jsonl`. Override the path with `H2_DEBUG_RESPONSES_FILE=/absolute/path.jsonl` if needed.

## Eval Prompts

Keep these prompts stable when checking mechanism choice regressions.

Inside the experiment boundary: should usually spawn at least one real experiment.

```text
I want to know whether a temporary dependency install done inside an isolated side-task workspace can stay fully confined there.

Do not edit code.

Investigate whether this harness can verify that behavior reliably, what the main uncertainty is, and what evidence most reduces uncertainty before implementation.
```

Outside the experiment boundary: should usually stay with direct reading or inline probes.

```text
I want to know how this harness should recover if the main process crashes while a side task is still running.

Do not edit code.

Investigate whether the current architecture can recover that state cleanly, what the riskiest assumptions are, and what evidence most reduces uncertainty before implementation.
```

Ambiguous boundary: should at least produce grounded evidence, and often one narrow experiment is reasonable.

```text
I’m considering allowing multiple side tasks to run at once in this harness.

Do not edit code.

Investigate whether the current system can support that safely, the main constraints, the smallest viable path, and what evidence most reduces uncertainty before implementation.
```

## OpenAI Codex OAuth

The prototype now includes a direct OpenAI Codex OAuth flow for local testing.

- `h2 auth login` starts a browser-based PKCE flow against `https://auth.openai.com`
- tokens are stored globally in `~/.h2/auth.sqlite`
- `h2 auth access` prints a refreshed bearer token to stdout for manual API testing
- `/auth login`, `/auth status`, and `/auth logout` are also available inside the OpenTUI UI
- once logged in, plain text in the interactive app is sent to the Codex backend using the stored OAuth token

Notes:

- the callback server listens on `127.0.0.1:1455` by default
- if the browser does not open, the CLI prints the authorization URL
- token refresh happens automatically when expiry is within five minutes
- the interactive UI does not print the raw bearer token into the transcript
- older repo-local auth tokens in `.h2/notebook.sqlite` are migrated into the global auth store automatically

## Layout

```text
src/
  cli.ts
  commands/doctor.ts
  engine/
  experiments/
  storage/
  ui-opentui/
packages/
  ui-opentui/
test/
```

## Notes

- State lives under `.h2/notebook.sqlite`.
- Experiment worktrees live under `.h2/worktrees/<experimentId>`.
- Adoption previews and patches live under `.h2/adoptions/<experimentId>.patch`.
- Resolved experiments remove their worktree unless `--preserve` is set.
- Token usage is currently a simple estimated counter based on emitted observation text.
- Model integration, cancellation, and richer editing commands are left as TODOs for later versions.
