# Security Policy

## Supported scope

The latest version on the `main` branch (0.5.x) is maintained.

## How to report

Do not disclose exploitable details in public issues. You can find the maintainer's contact information on the Gitee repository homepage, or first open an issue without vulnerability details to request private communication. Please include:

- affected modules and versions
- reproduction steps or a minimal example
- your assessment of the impact
- how you would like to be credited

After receiving a report, the maintainers first confirm whether the issue is reproducible, then provide a fix plan.

## Security boundaries

The code in this repository is designed around the following boundaries by default; understanding them helps determine whether an issue is a defect:

### PTC sandbox

- Read-only: no file writes, command execution, or network access.
- Syntax restrictions: `class`, `import`, `this`, `process`, and dynamic property access are forbidden; `new` is allowed only for Set, Map, Date, RegExp, Error, Array, Object, and Promise.
- Execution isolation: a separate worker thread plus `node:vm`; each run has an 8-second timeout and a 100 tool-call cap, and results over 24000 characters are truncated.
- Parameter validation: read-only tools validate type, range, unknown keys, and path traversal one by one.

The sandbox reduces the risk of model mistakes; it is not a strong isolation environment against malicious code. Do not run untrusted third-party code in the same process.

### Context prefetch and cold facts

- Prefetch reads only relative paths inside the workspace; absolute paths, drive letters, `..`, and excessively long paths are rejected.
- Body text is read only when the user message contains an explicit file path, line range, or symbol; otherwise only a path index is injected.
- Single-turn prefetch has a character limit, so snippets may be incomplete and are explicitly labeled when rendered.
- Prefetch and cold-fact content are always appended as data to the end of the user message and never enter the system prompt, tools, or the middle of the history.
- Workspace file content may contain prompt-injection text. This core only reads and truncates it and does not judge whether the content is trustworthy; when strong isolation is needed, add instruction filtering or human approval on the model side.

### Tool-result persistence

- Paths are validated by the two segments of `result_id`, rejecting `..` and illegal characters.
- The persistence directory must be inside the configured data directory.
- Summaries and previews are redacted for common secret formats.
- Result files expire after 30 days by default, and mtime is checked on read.

### Cache and logs

- Cache-hit logs record only token counts, prefix hashes, and task identifiers, never the prompt body.
- A failed log write does not affect the main flow.

## Out of scope

- the correctness of model-generated content itself
- model services and network environments the user integrates themselves
- features explicitly marked as experimental
