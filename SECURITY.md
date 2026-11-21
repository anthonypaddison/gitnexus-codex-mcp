# Security

## Report privately

Use private vulnerability reporting on the
[fork repository](https://github.com/anthonypaddison/gitnexus-codex-mcp/security/advisories/new)
when available. If the form is unavailable, request a private reporting channel
without including the details in a public issue. Include the fork commit, OS,
Node version and affected command or tool. Use synthetic repositories in any
diagnostic material. Exclude credentials, index files and private paths.

## Scope of the experimental release

The supported integration is the project-scoped local `mcp-safe` launcher.
Legacy web, HTTP, Docker, editor-plugin and unrestricted MCP entry points are
upstream code and outside this release's supported workflow. The inherited
automation under `.github/workflows.local-safe-disabled` is inactive. No
automatic GitHub publishing or security scans run from it.

Context mode requires explicit approval of each canonical repository root,
checks filesystem identity and index permissions, and restricts each connection
to its starting context. Disconnect old clients after revocation or policy
changes. Keep the policy, snapshots, and LadybugDB files private. Back up a
snapshot before changing it and investigate reported WAL or shadow sidecars
before opening it in another tool.

A read-only MCP response can still contain repository-controlled paths,
identifiers or other data. Treat that data as untrusted and use an appropriate
Codex data-handling policy. GitNexus itself is local; selecting a hosted model
can send tool results to that model. Review the project registration and tool
approvals before running it. The MCP process runs as your user; repository
allowlisting is not an operating-system privilege boundary.

Manual refresh uses OS-enforced write and network restrictions for the
candidate build and query probe, and keeps the previous snapshot for recovery.
Review the [setup and rollback guide](LOCAL_SAFE.md) before using it.
