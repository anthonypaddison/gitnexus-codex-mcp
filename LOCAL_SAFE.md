# Local-Safe Changes

The supported local MCP and manual refresh paths disable automatic downloads.
Initial dependency and FTS provisioning are explicit operator actions.

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

### Build the fork from source

Use Apple silicon macOS, Git, Node 22 with matching local headers, npm, Python 3,
Apple's command-line developer tools and Codex Desktop. The validated setup
uses Homebrew Node 22, a locked LadybugDB binary, and an explicit local Kotlin
grammar build. Optional Dart, Protobuf and Swift native grammar builds are
outside this installation. Windows and Linux have no release acceptance.
Refresh requires macOS `sandbox-exec` or a functioning Linux
`/usr/bin/bwrap`; the Linux path remains unverified.

Once the release exists, use its pinned source tag and compare the checkout's
commit to the SHA in the authenticated release notes before installing:

```sh
git clone --branch v0.1.0-experimental.1 --single-branch \
  https://github.com/anthonypaddison/gitnexus-codex-mcp.git
cd gitnexus-codex-mcp
git rev-parse HEAD
node --version
(cd gitnexus-shared && npm ci --ignore-scripts)
(cd gitnexus && npm ci --ignore-scripts)
cp gitnexus/node_modules/@ladybugdb/core-darwin-arm64/lbugjs.node \
  gitnexus/node_modules/@ladybugdb/core/lbugjs.node
NODE_PREFIX="$(dirname "$(dirname "$(node -p 'process.execPath')")")"
test -f "$NODE_PREFIX/include/node/node.h"
(cd gitnexus/node_modules/tree-sitter-kotlin && \
  /usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  node ../node-gyp/bin/node-gyp.js rebuild --nodedir="$NODE_PREFIX")
GITNEXUS_BUILD_CLI_ONLY=1 node gitnexus/scripts/build.js
node gitnexus/dist/cli/index.js --version
```

The clone and dependency install can use the network. Review the source and
lockfiles first. The copy uses the locked Apple silicon binary from the
dependency install, avoiding an automatic installer or source compilation.
The Kotlin build uses the supplied local Node headers with network access
blocked. The CLI build requires no web dependencies.
Use the absolute path to this checkout and your Node executable in Codex.
Avoid the unqualified npm package and inherited upstream install commands.

For FTS, provision the official extension matching the locked
`@ladybugdb/core` native engine and OS/architecture before indexing. Consult
[Ladybug's extension setup](https://docs.ladybugdb.com/extensions/) and
use its matching native release to explicitly install FTS into the same user's
cache. Fetching an extension is a separate operator action. The fork uses
load-only mode, so a missing or incompatible extension causes indexing to fail
or keyword features to degrade. Do not substitute an unverified native library.

### Set up and query one approved context

Choose a noncommercial repository you control and keep the snapshot and policy
outside repositories you share. The following commands use the fictional
`$HOME/Projects/example`. Run from the fork checkout:

```sh
umask 077
CLI="$PWD/gitnexus/dist/cli/index.js"
DATA="$HOME/.gitnexus"
POLICY="$DATA/contexts.local.yaml"
SNAPSHOTS="$DATA/snapshots"
LIVE="$HOME/Projects/example"
mkdir -p "$SNAPSHOTS"
git -c init.templateDir= clone --no-hardlinks -- "$LIVE" "$SNAPSHOTS/example"
node "$CLI" contexts --config "$POLICY" setup --parent "$SNAPSHOTS"
node "$CLI" contexts --config "$POLICY" approve example "$SNAPSHOTS/example"
node "$CLI" contexts --config "$POLICY" add personal example
node "$CLI" contexts --config "$POLICY" use personal
GITNEXUS_HOME="$DATA" GITNEXUS_LBUG_EXTENSION_INSTALL=load-only \
  node "$CLI" analyze --index-only "$SNAPSHOTS/example"
chmod go-rwx "$SNAPSHOTS/example/.gitnexus" \
  "$SNAPSHOTS/example/.gitnexus/meta.json" "$SNAPSHOTS/example/.gitnexus/lbug"
node "$CLI" contexts --config "$POLICY" status
```

Only index explicitly selected repositories. `--index-only` keeps agent
instructions and skills out of the indexing side effects. The analyzer can
update the local registry and candidate's Git exclusion. Setup only discovers
candidates. The CLI writes an owner-only policy with the correct root and
filesystem identity. See the optional example mapping below for freshness and
manual refresh.

Back up the project's existing `.codex/config.toml`, if present. In the
trusted project where you want the integration, add the following table using
real absolute paths. The sample paths are placeholders and TOML does not expand
shell variables. Keep the file local to your machine.

```toml
[mcp_servers.gitnexus]
enabled = true
command = "/absolute/path/to/node"
args = ["/absolute/path/to/fork/gitnexus/scripts/gitnexus-codex-mcp.mjs"]

[mcp_servers.gitnexus.env]
GITNEXUS_SAFE_REPOSITORY = ""
GITNEXUS_SAFE_CONTEXT_CONFIG = "/absolute/private/path/contexts.local.yaml"
```

Review project trust, the executable path, the private policy, and tool
approvals before opening a fresh Codex chat in that project. The expected tools
are `query`, `context`, `detect_changes`, `impact`, `route_map`, `tool_map`,
`shape_check`, and `api_impact`. Query an expected symbol with
`gitnexus.query`, selecting `context: personal` and `repository: example`.
Verify that the returned alias and indexed revision match the intended snapshot.

Use `contexts remove <context> <alias>` to remove one membership or
`contexts revoke <alias>` to revoke all access for that alias. These commands
preserve snapshots. Close existing clients when revoking access. To disable
the integration, set the project registration's `enabled = false` or restore
your previous project configuration after reviewing intervening edits. Close
its connected sessions. To uninstall, remove the fork checkout only after
disconnecting it and preserving any required local data.

Each connection uses only its startup context. `query` searches its members
sequentially unless given an exact `repository` alias. Other tools require an
alias when the context has multiple members. An optional `context` argument
must match the startup context. Context mode disables full source snippets and
supports staged or committed-revision comparisons for `detect_changes`.
It skips indexes that are stale or unknown relative to their own approved
checkout. A ready snapshot can also be behind its corresponding live checkout.
For that comparison, set an optional absolute, canonical `liveRoot` in the
owner-only policy on the existing repository entry. Keep `root` and `identity`
pointing to the approved indexed checkout.

```yaml
repositories:
  example:
    root: /path/to/approved/snapshots/example
    identity:
      device: '123'
      inode: '456'
    liveRoot: /path/to/live/example
```

`contexts status` and MCP results report the indexed revision, live HEAD and
`current`, `behind`, `ahead/diverged` or `unknown`. `behind` results describe an
older snapshot, with a commit count when known. `ready` describes the index's
own checkout. Without a live mapping or sufficient readable history, live
freshness is unknown. The live path is used only for Git metadata and never
grants direct search access. Freshness compares commits and does not inspect
uncommitted edits or trigger indexing.

### Refresh one approved snapshot manually

```bash
gitnexus contexts --config /path/to/contexts.yaml refresh example --expect-head <full-live-commit>
gitnexus contexts --config /path/to/contexts.yaml status
```

Run the built local CLI on macOS with the system sandbox and a compatible
LadybugDB FTS extension already in the local cache. The alias must be approved in
the active context and have a `liveRoot`. Refresh materializes the specified
commit under the approved snapshot parent and runs `analyze --index-only` with
network access blocked and a private registry. It validates the index and a
read-only FTS query before switching the alias. Dirty live changes never enter
the snapshot. Unsupported Git entries such as symlinks or submodules fail the
refresh rather than importing files outside the committed tree.
The candidate contains the selected commit and its tree, without prior Git
history. Revision comparisons against another commit are unavailable in that
snapshot. Refresh rejects a Git pack or blob batch over 128 MiB.

The original snapshot and its index remain on disk. Refresh prints the old and
new snapshot paths and the private policy backup. Start a new MCP connection to
use the new snapshot. Existing connections keep their previous snapshot.
Repeated refreshes require additional disk space. To undo a successful refresh,
compare the current policy against the backup first. If the only change is this
alias's `root` and `identity`, atomically restore the backup while no other
policy writers are running. If the policy changed since, restore only those two
fields for the alias and preserve intervening edits.

Context mode expects private index paths, rejects symlinks and WAL/shadow sidecars, and will report that
operator recovery is required instead of attempting it. Index maintenance is
a separate operator action. Use synthetic or eligible noncommercial repositories
until commercial permission is established for company use.

The real context integration test requires a compiled checkout supplied as
`GITNEXUS_CONTEXT_TEST_APP`. Use an isolated build if the checkout currently
serves an installed integration. The test creates and cleans up only disposable
synthetic repositories and their indexes.
