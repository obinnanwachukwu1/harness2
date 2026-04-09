# Eval Fixtures

Committed eval assets live here.

- `wide-suite.toml` is the current 15-session suite.
- `stability-pack.toml` is the 6-case repeatability pack and defaults to 5 fresh runs.
- `comparison-stage1.toml` is the 10-task core short/medium comparison stage.
- `comparison-stage2.toml` is the 4-task product/non-greenfield extension stage.
- `comparison-stage3.toml` is the 2-task long-horizon compaction/continuity stage.
- `comparison-stage3b-75k.toml` is the optional 75k effective-context stress rerun for Stage 3.
- `npm run dev -- eval pack --latest-batch` packs the latest repeat batch into one review zip.
- `fixtures/node-minimal` is `F1`.
- `fixtures/node-service-starter` is `F2`.
- `fixtures/next-app-router` is `F3`.
- `fixtures/vite-react` is `F4`.
- `F5` is the current `run-harness2` repo via `git_checkout`, not a copied fixture directory.
- `F6` / `F7` / `F8` are pinned remote git checkouts for `vercel/chatbot`, `healthchecks/healthchecks`, and `sissbruecker/linkding`.

Secret-bearing env files are not committed here.

Recommended local env sources:

- `~/.h2/eval-env/next-app-router-openai.env` for `C1`
- `~/.h2/eval-env/node-minimal-openai.env` for `C2`

Those files are materialized into fresh per-case workspaces at run time.

Comparison pack usage:

- `h2 eval run evals/comparison-stage1.toml --mode study`
- `h2 eval run evals/comparison-stage1.toml --mode plan`
- `h2 eval run evals/comparison-stage1.toml --mode direct`
- `h2 eval run evals/comparison-stage3b-75k.toml --mode study`

The comparison manifests are mode-neutral by default and are intended to be rerun with `--mode study|plan|direct`.
`comparison-stage3b-75k.toml` sets `context_window_tokens = 75000` and forces `parallelism = 1`.
