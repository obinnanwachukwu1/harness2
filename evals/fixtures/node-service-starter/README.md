# Node Service Starter

Minimal backend-heavy starter for evals.

Current behavior:

- `GET /health` returns a small JSON health payload.
- `GET /api/items` returns items from `data/items.json` when present.
- If no backing file exists, `GET /api/items` returns an in-memory fallback list.
- No auth, no database, no external packages.

Run locally:

```bash
npm start
```
