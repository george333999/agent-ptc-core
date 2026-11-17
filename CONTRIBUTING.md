# Contributing

Thanks for taking a look at this reference implementation.

## Local checks

```bash
npm install
npm test
npm run demo
```

## Scope

This repository focuses on the Orchestrator-Worker + PTC structure. Host-specific model providers, IDE UI, MCP, terminal and document tooling are intentionally kept in `src/reference/` as integration examples, not as part of the minimal core.

## Pull requests

- Keep changes focused on orchestration, PTC, sandboxing or observability.
- Add or update a test under `test/`.
- Do not add secrets, API keys or local absolute paths.
- Prefer dependency injection over importing a specific host application.
