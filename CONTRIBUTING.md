# Contributing

Thanks for your interest. This repository prioritizes small, verifiable changes, especially those that improve cache stability, reduce tool round-trips, or add benchmark data.

## Development environment

- Node.js 20 or later
- No database or external services required
- PTC code requires `acorn`

```bash
npm install
npm test
npm run example:minimal
npm run example:context
npm run example:ptc
```

## Publishing to Gitee

For the full pre-release checks, repository creation, remote setup, and version tagging steps, see [docs/release-gitee.md](docs/release-gitee.md).

## Pre-commit checks

1. `npm test` must pass completely.
2. Changes to prefix or window logic must explain their impact on "whether the request prefix remains append-only".
3. Changes to the context engine must ensure that prefetch, cold facts, artifact index, and task memo are appended only to the end of the user message and never inserted into the system prompt, tools, or the middle of the history.
4. Changes to tool results must explain whether redaction, path constraints, and failure fallback still hold.
5. Benchmark changes should include the run environment, model, turns, and raw result files.

## Code conventions

- Use ESM consistently and keep `type: module`.
- Do not add new runtime dependencies unless they clearly reduce complexity, with the rationale given in the description.
- Comments explain "why", not what the code already says.
- New behavior must have corresponding tests; for bug fixes, add a test that reproduces the problem first.

## Commit messages

Use a concise prefix style:

- `feat:` new capability
- `fix:` bug fix
- `perf:` performance or token optimization
- `docs:` documentation
- `test:` tests

Example: `perf: keep tool schema order stable to avoid prefix drift`

## Branches and merging

- Create feature branches from `main`.
- One commit does one thing.
- Make sure tests pass before merging, and state the verification method in the description.

## Code of conduct

Keep discussion focused on technical facts, not individuals. Do not post content about undisclosed security issues in public issues.
