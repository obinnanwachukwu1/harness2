# Public Evals

This directory contains a public-safe subset of the project's eval manifests.

Design constraints for this pack:

- no secret-bearing `env_source` files
- no references to the live `harness2` repo checkout
- no dependency on user-local paths like `~/.h2/...`
- only committed fixture repos under `evals/fixtures/`

The current public suite is [public-safe-suite.toml](public-safe-suite.toml).

## Included Fixtures

- `node-minimal`
- `node-service-starter`
- `next-app-router`
- `vite-react`

These are referenced from `../evals/fixtures/` so the existing maintainer evals remain unchanged.

## Included Cases

- `A1-A4`: straightforward local implementation tasks
- `B2-B5`: contract-clarification tasks on committed fixtures
- `C3-C5`: bounded runtime-verification tasks that do not require external credentials

## Excluded Cases

The public pack intentionally excludes:

- cases that depend on local secret env files
- cases that require the live `harness2` checkout as the fixture
- maintainer-oriented comparison/stress manifests

## Usage

Run the full public suite:

```bash
npm run dev -- eval run public-evals/public-safe-suite.toml
```

Run a single public case:

```bash
npm run dev -- eval run public-evals/public-safe-suite.toml --case A4
```

## Notes

- results are only comparable when the same model, mode, and runtime settings are used
- `next-app-router` and `vite-react` fixtures still run `npm ci` inside their fresh workspaces
- this pack is intended for public reproducibility, not for maintainer-only benchmarking
