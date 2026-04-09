# Eval Fixtures

Committed eval assets live here.

- `wide-suite.toml` is the current 15-session suite.
- `fixtures/node-minimal` is `F1`.
- `fixtures/node-service-starter` is `F2`.
- `fixtures/next-app-router` is `F3`.
- `fixtures/vite-react` is `F4`.
- `F5` is the current `run-harness2` repo via `git_checkout`, not a copied fixture directory.

Secret-bearing env files are not committed here.

Recommended local env sources:

- `~/.h2/eval-env/next-app-router-openai.env` for `C1`
- `~/.h2/eval-env/node-minimal-openai.env` for `C2`

Those files are materialized into fresh per-case workspaces at run time.
