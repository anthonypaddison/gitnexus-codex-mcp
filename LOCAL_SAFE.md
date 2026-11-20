# Local-Safe Changes

This copy is patched to prevent GitNexus from initiating outbound network calls.

Disabled runtime paths:

- `gitnexus publish` repository dispatch
- HTTP embedding backends
- Hugging Face model downloads for embeddings
- MCP embedding model loading
- Wiki LLM API calls
- Web LLM provider creation
- OpenRouter model list fetching
- Server-side remote git clone/pull
- CDN scripts in generated wiki HTML
- Persisted MCP `npx` fallback entries
- Hook `npx` fallback entries
- DuckDB/Ladybug extension installation
- Build/test helper `npx` invocations
- Automatic web dependency install from the build script
- Docker build recipes that ran package-manager and OS-package network operations
- Vercel install command
- Eval Docker/MCP bridge tooling that used package-manager bootstrap commands
- GitHub Actions and Dependabot entrypoints
- Automatic external web font loads and clickable external links in the local web UI

Removed install-time telemetry dependency:

- `@scarf/scarf`

Removed embedding/model runtime dependencies:

- `@huggingface/transformers`
- `onnxruntime-node`

Some inactive comments, fixtures, README text, and disabled workflow files still contain URLs.

## Opt-in repository contexts

`mcp-safe --repo /absolute/repository` still selects one repository. Context mode
uses `mcp-safe --contexts /absolute/contexts.yaml` or sets
`GITNEXUS_SAFE_CONTEXT_CONFIG` on the existing local Node launcher. Set only one
of the launcher variables. The default CLI policy path is
`~/.gitnexus/contexts.yaml`.

From a locally built checkout, use the following operator workflow. The paths
and aliases here are examples for eligible noncommercial repositories.

```sh
NODE=/opt/homebrew/opt/node@22/bin/node
"$NODE" gitnexus/dist/cli/index.js contexts setup --parent ~/Projects
"$NODE" gitnexus/dist/cli/index.js contexts approve example ~/Projects/example
"$NODE" gitnexus/dist/cli/index.js contexts add personal example
"$NODE" gitnexus/dist/cli/index.js contexts use personal
"$NODE" gitnexus/dist/cli/index.js contexts status
```

Setup lists candidates without approving or indexing them. `approve` records
the canonical root and directory identity. Use `remove <context> <repository>`
for membership, and `revoke <repository>` to remove approval everywhere.
These commands leave indexes intact. Policy changes apply to new connections.
Close existing clients when revoking access. Use `contexts --config <file>` to
choose another policy file. A version 1 policy contains `parent`,
`repositories` (alias to root and device/inode identity), `contexts` (context
to approved aliases), and optional `activeContext`. Use the CLI to record
identity and save the file with mode 0600.

For an approved Desktop rollout, build the checkout locally using the existing
Node 22 runtime, then put the following registration in the trusted
`~/Projects/.codex/config.toml`. Preserve unrelated entries and keep the global
registration disabled. Before rollout, check that a nested project does not
load an unintended second registration. Reopen the target Desktop session and
verify the effective tool inventory there.

```toml
[mcp_servers.gitnexus]
enabled = true
command = "/opt/homebrew/opt/node@22/bin/node"
args = ["/Users/anthonypaddison/Projects/gitnexus-codex-mcp/gitnexus/scripts/gitnexus-codex-mcp.mjs"]

[mcp_servers.gitnexus.env]
GITNEXUS_SAFE_CONTEXT_CONFIG = "/Users/anthonypaddison/.gitnexus/contexts.yaml"
```

Each connection uses only its startup context. `query` searches its members
sequentially unless given an exact `repository` alias. Other tools require an
alias when the context has multiple members. An optional `context` argument
must match the startup context. Context mode disables full source snippets and
supports staged or committed-revision comparisons for `detect_changes`.
It skips stale or unknown indexes and labels each result or unavailable member.
Freshness is based on the indexed Git commit. Context mode expects private
index paths, rejects symlinks and WAL/shadow sidecars, and will report that
operator recovery is required instead of attempting it. Index maintenance is
a separate operator action. Use synthetic or eligible noncommercial repositories
until commercial permission is established for company use.

The real context integration test requires a compiled checkout supplied as
`GITNEXUS_CONTEXT_TEST_APP`. Use an isolated build if the checkout currently
serves an installed integration. The test creates and cleans up only disposable
synthetic repositories and their indexes.
