# Harbor Integration

`h2` now exposes a Harbor-facing single-trial entrypoint:

```bash
h2 harbor-run \
  --output-dir /logs/agent \
  --instruction-file /tmp/h2-instruction.md \
  --json
```

This is intentionally narrower than `h2 eval run`.

- Harbor remains responsible for task download, environment build, sandbox lifecycle, and verifier execution.
- `h2 harbor-run` is responsible for one session in the current workspace plus artifact export.
- The command exports Harbor-friendly artifacts into the requested output directory, including `trajectory.json`.
- If the current workspace is not already a git repo with a commit, `h2 harbor-run` bootstraps one automatically before opening the session.

## CLI Contract

Required:

- `--output-dir <path>`
- one of:
  - `--instruction "<text>"`
  - `--instruction-file <path>`

Optional:

- `--session <id>`
- `--model <name>`
- `--reasoning-effort <off|low|medium|high>`
- `--web-search-mode <disabled|cached|live>`
- `--thinking`
- `--no-thinking`
- `--json`

When `--json` is set, stdout is machine-readable JSON only. Transcript streaming is suppressed so Harbor wrappers can safely parse the result.

## Exported Files

`h2 harbor-run` writes these files into `--output-dir`:

- `summary.json`
- `instruction.txt`
- `session.md`
- `transcript.json`
- `model-history.json`
- `questions.json`
- `experiments.json`
- `runtime.json`
- `git-status.txt`
- `diff.patch`
- `trajectory.json`

`trajectory.json` is a minimal ATIF export derived from durable notebook/model-history state. It is intended for Harbor viewer compatibility first; token and cost metrics are not yet populated because `h2` does not persist them durably.

## Harbor Wrapper

A sample Harbor custom installed-agent wrapper lives in [h2_installed_agent.py](./h2_installed_agent.py).

A cheap local framework smoke task lives in [tasks/next-app-router-heading-smoke](./tasks/next-app-router-heading-smoke/README.md). Use it before trying larger Harbor datasets or Terminal-Bench.

Run it with Harbor using `--agent-import-path`, for example:

```bash
harbor run \
  -d "<dataset@version>" \
  --agent-import-path docs.harbor.h2_installed_agent:H2InstalledAgent
```

The sample wrapper also exposes `mode` as a custom agent kwarg. If omitted, it runs in `study` mode. To force `plan` or `direct`, pass:

```bash
harbor run \
  -d "<dataset@version>" \
  --agent-import-path docs.harbor.h2_installed_agent:H2InstalledAgent \
  --agent-kwarg mode=plan
```

or:

```bash
harbor run \
  -d "<dataset@version>" \
  --agent-import-path docs.harbor.h2_installed_agent:H2InstalledAgent \
  --agent-kwarg mode=direct
```

You will usually also want to set an install source for `h2`, for example:

```bash
export H2_INSTALL_SPEC="github:your-org/harness2"
```

For no-network Harbor tasks, prefer a prebuilt runtime bundle instead of in-container package installation:

```bash
./scripts/build-harbor-runtime.sh /tmp/h2-harbor-runtime.tar.gz
export H2_RUNTIME_BUNDLE_PATH="/tmp/h2-harbor-runtime.tar.gz"
```

When `H2_RUNTIME_BUNDLE_PATH` is set, the sample wrapper uploads that bundle into the task container and runs `/opt/h2-runtime/bin/h2` directly. This avoids `apt` and `npm` inside the task environment.

By default the bundle reuses the container's existing `node`. If you are preparing the bundle on a Linux Harbor host and want to ship a matching Node binary inside it, set:

```bash
H2_INCLUDE_NODE_BINARY=1 ./scripts/build-harbor-runtime.sh /tmp/h2-harbor-runtime.tar.gz
```

If your Harbor run needs Codex OAuth auth, set:

```bash
export H2_AUTH_DB_PATH="$HOME/.h2/auth.sqlite"
```

The sample wrapper treats `H2_AUTH_DB_PATH` as a host-side path, uploads that SQLite file into the task environment, and then points the in-container `h2` process at the uploaded copy automatically.
