# Eval Manifest Schema

## Goals

The eval manifest should be:

- safe to commit
- explicit about runtime and fixture behavior
- expressive enough for multi-turn suites
- strict enough to fail early when env or fixture prerequisites are missing

Secret values are never stored in the manifest. The manifest describes env shape and env sources, not secret contents.

## Top-Level Shape

```toml
[suite]
id = "wide-15"
description = "Wide decision-boundary eval suite"

[runtime]
reasoning_effort = "medium"
thinking = false
web_search_mode = "fixed"
repeat_count = 5
max_steps = 40
default_experiment_budget = 1200

[clarification]
auto_reply = "Make the best grounded minimal choice and proceed. Keep the contract explicit."
mark_as_unnecessary = true

[[fixtures]]
id = "node-minimal"
type = "template"
path = "evals/fixtures/node-minimal"

[[fixtures]]
id = "next-app-router"
type = "template"
path = "evals/fixtures/next-app-router"

[[cases]]
id = "A1"
bucket = "A"
fixture = "node-minimal"
profile = "backend/cli"
prompt = "In this Node repo, build a tiny CLI..."
question_expected = false
experiment_expected = false
web_search_expected = "no"

[[cases]]
id = "B1"
bucket = "C"
fixture = "next-app-router"
profile = "ai/full-stack"
prompt = "In this Next.js repo, build a minimal chatbot using .env.local..."
question_expected = true
experiment_expected = true
web_search_expected = "yes"
```

## Sections

### `[suite]`

Required:

- `id`: stable suite id

Optional:

- `description`: human-readable label

### `[runtime]`

Pinned defaults for the whole suite.

Required:

- `reasoning_effort`

Optional:

- `model`
- `thinking`
- `web_search_mode`
- `repeat_count`
- `max_steps`
- `default_experiment_budget`

If `model` is omitted, the runner leaves the session on the harness client's existing default model. For backward compatibility, `model = "default"` is treated the same way.

`reasoning_effort` values:

- `off`
- `low`
- `medium`
- `high`

`web_search_mode` values:

- `disabled`
- `cached`
- `live`
- `fixed`

`fixed` means the manifest locks whatever explicit mode the runner resolves for the suite and uses it consistently across all cases.

`repeat_count` runs the same selected case set as fresh independent eval runs multiple times. Each repeat gets its own run id and fresh workspaces.

### `[clarification]`

Optional suite-wide fallback when the model asks an unplanned question.

Fields:

- `auto_reply`: string sent once when clarification fallback is enabled
- `mark_as_unnecessary`: boolean flag that pre-marks the case for soft-fail review when fallback is used

### `[[fixtures]]`

A fixture defines how to build a fresh case workspace.

Required:

- `id`
- `type`
- `path`

Optional:

- `ref`: required for `git_checkout` in practice
- `setup_command`
- `env_source`
- `write_env_file`
- `write_env_example`
- `validate_env_example`

`type` values:

- `template`: copy a committed directory into a fresh case workspace
- `git_checkout`: create a fresh checkout/worktree from a repo path and ref

Fixture rules:

- fixture contents are safe to commit
- real secret-bearing `.env` files are not stored in fixture directories
- real env comes from `env_source` or process inheritance at run time
- generated `.env.example` is safe to export

#### Env Source

`env_source` is a local or user-level source of secret-bearing values.

Recommended default:

```toml
env_source = "~/.h2/eval-env/<fixture-id>.env"
```

Runner behavior:

- if `env_source` is set and missing, fail before the case starts
- if `write_env_file` is set, copy the resolved env file into the fresh workspace
- if `write_env_example` is set, generate a redacted dotenv file in the fresh workspace

#### `.env.example` Generation

If an env source is loaded, the runner should generate:

```dotenv
OPENAI_API_KEY=
OPENAI_BASE_URL=http://127.0.0.1:8787
```

Redaction rules:

- blank secret values by default
- preserve obviously non-secret literals when known safe
- never emit actual secret values into exports or logs

### `[[cases]]`

A case is one fresh session in one fresh workspace.

Required:

- `id`
- `bucket`
- `fixture`
- `prompt`

Optional:

- `notes`
- `question_expected`
- `experiment_expected`
- `web_search_expected`
- `runtime_override.*`
- `review_hints`

`bucket` values:

- `A`
- `B`
- `C`
- `W`

`profile` is a required freeform label used in the score sheet, for example:

- `frontend`
- `backend`
- `full-stack history contract`
- `ai/runtime`

`web_search_expected` values:

- `yes`
- `no`
- `optional`

`experiment_expected` values:

- `yes`
- `no`
- `optional`

`optional` means either a bounded inline probe episode or a spawned experiment is acceptable evidence for that case.

Expected flags:

- `question_expected`: boolean
- `experiment_expected`: `yes` / `no` / `optional`

These are expectations, not score results.

### `[[cases.followups]]`

Optional additional user turns for the same session and same workspace.

Required:

- `after_turn`
- `prompt`

Rules:

- follow-ups run only after the previous turn reaches stable completion
- notebook state is preserved
- repo state is preserved
- no fixture reset occurs between follow-up turns

## Optional Per-Case Runtime Override

```toml
[[cases]]
id = "W1"
bucket = "W"
fixture = "empty-node"
prompt = "..."
question_expected = true
experiment_expected = false

[cases.runtime_override]
web_search_mode = "live"
```

Per-case overrides should be rare. The suite should stay pinned unless a case specifically exists to test a different runtime mode.

## Optional Per-Case Env Override

Use only when a case needs extra env keys beyond the fixture default.

```toml
[[cases]]
id = "W1"
bucket = "W"
fixture = "openai-streaming"
prompt = "..."

[cases.env_override]
env_source = "~/.h2/eval-env/openai-live.env"
write_env_file = ".env.local"
```

Case-level env should layer on top of the fixture, not replace the whole fixture contract silently.

## Failure Rules

The runner should fail the case before model execution when:

- fixture path is missing
- git ref is invalid
- env source is required and missing
- generated workspace cannot be created
- runtime config is invalid

The runner should fail the suite immediately only for suite-level invalid configuration. Case-level materialization failures should be recorded as case failures with explicit diagnostics.
