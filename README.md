# harness2

`harness2` is a small experimental coding harness that proves one vertical slice:

- a headless main engine owns transcript state and tool execution
- a scoped experiment runs in an isolated `git worktree`
- experiment state is persisted in SQLite
- an Ink terminal UI renders the transcript, experiments, status bar, and composer

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
/quit
```

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
