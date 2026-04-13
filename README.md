# harness2

`harness2` is an experimental coding harness for local repository work.

Today it provides one working vertical slice:

- a headless engine that owns transcript state and local tool execution
- isolated experiment runs in `git worktree`s
- SQLite-backed session and experiment state
- an interactive terminal UI
- a noninteractive print mode for one-shot prompts
- optional OpenAI Codex OAuth for model-backed interactions

This project is still early. The core path works, but the surface area and UX are still evolving.

## Requirements

- Node 22+
- npm 10+
- Bun 1.x for the UI frontend
- a Git repository with at least one commit in the working directory

Node-only commands such as `doctor`, `help`, `paths`, `auth`, `-p`, `test`, `typecheck`, and `build` do not require Bun. The interactive UI path does because `@opentui/core` imports `bun:ffi`.

## Install

Install from the repository root:

```bash
npm install
```

The root package uses npm workspaces, so this installs the core CLI dependencies and the UI package dependencies in one step.

## Quick Start

Check the local environment:

```bash
npm run dev -- doctor
npm run dev -- help
```

Run the interactive UI:

```bash
npm run dev
```

Run the noninteractive print mode:

```bash
npm run dev -- -p "inspect the repo"
```

Build and test:

```bash
npm test
npm run typecheck
npm run build
```

## Commands

Useful CLI commands:

```bash
npm run dev -- doctor
npm run dev -- help
npm run dev -- paths
npm run dev -- auth login
npm run dev -- auth status
npm run dev -- auth access
npm run dev -- auth logout
npm run dev -- -p "inspect the repo"
npm run dev -- -thinking -p "inspect the repo"
npm run dev -- resume <sessionId> -p "continue from here"
npm run dev -- resume <sessionId> -thinking -p "continue from here"
npm run dev -- resume <sessionId>
npm run dev -- ui
npm run dev -- ui <sessionId>
npm run dev -- eval run evals/wide-suite.toml --case A1
npm run dev -- eval score ~/.h2/evals/<run-id>
npm run dev -- harbor-run --output-dir /tmp/harbor-agent --instruction-file /tmp/instruction.md --json
```

Inside the terminal UI, use slash commands:

```text
/help
/auth login
/auth status
/auth logout
/model
/model gpt-5.4
/reasoning medium
/thinking on
/thinking off
/export
/clear-journal
/quit
```

Slash commands are reserved for app/session controls. File reads, edits, shell commands, experiments, and other tool operations are model-internal capabilities rather than direct user commands.

## Authentication

Model-backed prompt execution requires OpenAI Codex OAuth.

- `h2 auth login` starts a browser-based PKCE flow against `https://auth.openai.com`
- tokens are stored globally in `~/.h2/auth.sqlite`
- `h2 auth access` prints a refreshed bearer token to stdout for manual API testing
- `/auth login`, `/auth status`, and `/auth logout` are available inside UI

Notes:

- the callback server listens on `127.0.0.1:1455` by default
- if the browser does not open, the CLI prints the authorization URL
- token refresh happens automatically when expiry is within five minutes
- the interactive UI does not print the raw bearer token into the transcript
- older repo-local auth tokens in `.h2/notebook.sqlite` are migrated into the global auth store automatically

If you are not authenticated, the repo is still usable for local commands, tests, eval tooling, and other non-model workflows.

## Prompt Mode

For a noninteractive one-shot mode with streamed output, use:

```bash
npm run dev -- -p "what does this project do?"
npm run dev -- -thinking -p "what does this project do?"
npm run dev -- resume <sessionId> -p "continue the previous investigation"
npm run dev -- resume <sessionId> -thinking -p "continue the previous investigation"
```

To debug raw model response shapes:

```bash
H2_DEBUG_RESPONSES=1 npm run dev -- -p "inspect the repo"
```

This writes JSONL debug records to `.h2/debug/responses.jsonl`. Override the path with `H2_DEBUG_RESPONSES_FILE=/absolute/path.jsonl` if needed.

## Harbor

For Harbor/Terminal-Bench integration, use the single-session Harbor entrypoint instead of `h2 eval run`:

```bash
npm run dev -- harbor-run \
  --output-dir /tmp/harbor-agent \
  --instruction-file /tmp/instruction.md \
  --json
```

This exports Harbor-friendly artifacts including `trajectory.json`, `session.md`, `transcript.json`, `model-history.json`, and `summary.json`.

Use [docs/harbor/README.md](docs/harbor/README.md) for the wrapper contract and the sample Harbor custom installed-agent.

## Eval Suites

Public-safe eval manifests live under `public-evals/`.

- `public-evals/public-safe-suite.toml` is the default public eval pack.
- `npm run dev -- eval run public-evals/public-safe-suite.toml` runs the full public suite.
- `npm run dev -- eval run public-evals/public-safe-suite.toml --case A4` runs one public case.

Maintainer-oriented eval fixtures and benchmark manifests live under `evals/`.

- `evals/wide-suite.toml` is the current 15-session suite.
- `evals/stability-pack.toml` is the 6-case stability pack and defaults to 5 fresh runs.
- `evals/fixtures/` contains the committed reusable fixture repos.
- `npm run dev -- eval run evals/wide-suite.toml` runs the full suite.
- `npm run dev -- eval run evals/wide-suite.toml --case C3` runs one case.
- `npm run dev -- eval run evals/stability-pack.toml` runs the stability pack.
- `npm run dev -- eval run evals/stability-pack.toml --repeat 3` overrides the manifest repeat count.
- `npm run dev -- eval score ~/.h2/evals/<run-id>` recomputes the score sheet from artifacts.
- `npm run dev -- eval pack --latest-batch` packs the latest repeated-run batch into one review zip.

Use [public-evals/README.md](public-evals/README.md) for the public/reproducible path. Use [evals/README.md](evals/README.md) and [docs/evals/manifest-schema.md](docs/evals/manifest-schema.md) for maintainer-specific benchmarking notes.

## Layout

```text
src/
  cli.ts
  commands/doctor.ts
  engine/
  experiments/
  integrations/
  storage/
  ui/
packages/
  ui/
test/
```

## State

- repo-local state lives under `.h2/`
- global auth state lives under `~/.h2/auth.sqlite` unless `H2_HOME` or `H2_AUTH_DB_PATH` overrides it
- `h2 paths` prints the repo state dir, repo notebook, legacy `.harness2` dir, and global auth paths
- experiment worktrees live under `.h2/worktrees/<experimentId>`
- adoption previews and patches live under `.h2/adoptions/<experimentId>.patch`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT. See [LICENSE](LICENSE).
