# Eval Runner Design

This directory documents the proposed first-class eval workflow for `harness2`.

The goal is to replace manual one-off prompt runs and shell capture scripts with a reproducible eval runner that:

- provisions a fresh workspace per case
- pins runtime settings for the entire suite
- supports multi-turn scripted cases
- materializes runtime env safely
- exports structured artifacts
- scores from notebook and model-history state instead of transcript guessing

This is a design package, not an implementation. The design is split on purpose to avoid a single god doc and to map cleanly onto future modules.

Files:

- `manifest-schema.md`: committed TOML suite format, fixture/env rules, and case structure
- `type-model.md`: proposed TypeScript interfaces and implementation module boundaries

Recommended implementation split:

- `src/evals/manifest-types.ts`
- `src/evals/manifest-parse.ts`
- `src/evals/fixture-materialize.ts`
- `src/evals/env-materialize.ts`
- `src/evals/case-runner.ts`
- `src/evals/suite-runner.ts`
- `src/evals/scoring.ts`
- `src/evals/export.ts`

That keeps the eventual feature separated by responsibility:

- schema and validation
- fixture/env provisioning
- case execution
- suite orchestration
- scoring and export
