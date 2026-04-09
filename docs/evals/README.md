# Eval Runner Design

This directory documents the committed first-class eval workflow for `harness2`.

The goal is to replace manual one-off prompt runs and shell capture scripts with a reproducible eval runner that:

- provisions a fresh workspace per case
- pins runtime settings for the entire suite
- supports multi-turn scripted cases
- materializes runtime env safely
- exports structured artifacts
- scores from notebook and model-history state instead of transcript guessing

The implementation now lives under `src/evals/`, and the committed suite/fixtures live under `evals/`.

Files:

- `../wide-suite.toml`: committed 15-session suite
- `../stability-pack.toml`: committed 6-case repeatability pack with 5 fresh runs by default
- `../fixtures/`: committed reusable fixture repos
- `manifest-schema.md`: committed TOML suite format, fixture/env rules, and case structure
- `type-model.md`: proposed TypeScript interfaces and implementation module boundaries

Operational notes:

- `h2 eval pack --latest-batch` packages the newest repeated-run batch into one review zip.
