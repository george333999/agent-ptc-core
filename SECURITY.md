# Security

## Sandbox boundary

PTC code runs inside a Node.js `worker_threads` worker with a `vm` context. It is process-level isolation, not a container or VM boundary. Do not run untrusted multi-tenant code with it without an additional container sandbox.

## Read-only by design

The PTC namespace exposes only read-only tools (`files.list`, `files.read`, `files.search`, `knowledge.search`, `skills.read`). Write, shell, MCP and sub-agent operations remain direct tools and must be protected by your host approval policy.

## Limits

- AST validation before execution (syntax, escape syntax, bindings)
- Maximum 30 tool calls per run
- Wall-clock timeout (default 8 seconds)
- Output truncation
- Per-task namespace isolation

## Reporting

If you find a sandbox escape or path traversal issue, please open a private security advisory instead of a public issue.
