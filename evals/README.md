# Eval Fixtures

This directory is maintainer-oriented. These manifests are for internal benchmarking, repeatability checks, and heavier comparison/stress runs. The public-facing eval entrypoint is [../public-evals/README.md](../public-evals/README.md).

Committed eval assets live here.

- `wide-suite.toml` is the current 15-session suite.
- `stability-pack.toml` is the 6-case repeatability pack and defaults to 5 fresh runs.
- `comparison-stage1.toml` is the 10-task core short/medium comparison stage.
- `comparison-stage2.toml` is the 4-task product/non-greenfield extension stage.
- `comparison-stage3.toml` is the 2-task long-horizon compaction/continuity stage.
- `comparison-stage3b-75k.toml` is the optional 75k effective-context stress rerun for Stage 3.
- `comparison-stage-heavy.toml` is the 3-case heavy compaction coherence pack (`H1-H3`) with 10 prompts per case and a 75k effective-context cap.
- `comparison-stage-hc1.toml` is the targeted unresolved-state compaction proof case (`HC1`), intended to force a compaction while at least one question and one bounded study are still live.
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
- `h2 eval run evals/comparison-stage-heavy.toml --mode study --case H1`
- `h2 eval run evals/comparison-stage-hc1.toml --mode study`

The comparison manifests are mode-neutral by default and are intended to be rerun with `--mode study|plan|direct`.
`comparison-stage3b-75k.toml` sets `context_window_tokens = 75000` and forces `parallelism = 1`.
`comparison-stage-heavy.toml` also pins `context_window_tokens = 75000`, defaults to `parallelism = 1`, and treats `H1/H2` as the primary pair with `H3` as the reserve benchmark.
`comparison-stage-hc1.toml` also pins `context_window_tokens = 75000`, enables a one-shot forced study compact while unresolved state is live, and is intentionally diagnostic rather than balanced: it is meant to validate compaction of unresolved state, not broad finish-rate comparisons.
