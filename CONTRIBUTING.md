# Contributing

## Development Setup

Requirements:

- Node 22+
- npm 10+
- Bun 1.x for OpenTUI work

Install dependencies from the repository root:

```bash
npm install
```

Useful commands:

```bash
npm test
npm run typecheck
npm run build
npm run dev -- help
npm run dev -- doctor
```

## Workflow

- keep changes scoped and reviewable
- add or update tests when behavior changes
- run `npm test` and `npm run build` before opening a pull request
- update documentation when flags, commands, or setup behavior changes

## Pull Requests

- describe the user-visible change and the motivation
- call out any behavior that is intentionally incomplete or deferred
- include reproduction steps for bug fixes when practical

## Security

Do not open public issues for security-sensitive problems. Follow [SECURITY.md](SECURITY.md) instead.

## Conduct

Participation in this project is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
