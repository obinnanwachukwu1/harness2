# next-app-router-heading-smoke

Cheap local Harbor smoke task for the `h2` Harbor wrapper.

This task vendors the existing `evals/fixtures/next-app-router` app into the Harbor task environment so the task runs against a real framework repo with a git history.

What it checks:

- the custom Harbor `H2InstalledAgent` can run `h2 harbor-run`
- `h2` can operate inside a Harbor-managed framework repo
- the agent can make a small targeted edit in `app/page.tsx`
- the verifier can confirm the change and run `npm run build`

Suggested usage from the repo root:

```bash
harbor run \
  -p docs/harbor/tasks/next-app-router-heading-smoke \
  --agent-import-path docs.harbor.h2_installed_agent:H2InstalledAgent
```
