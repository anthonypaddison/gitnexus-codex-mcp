# GitNexus Codex MCP v1.0.0 release gates

Assessment date: 22 November 2026. Verdict: **NOT READY**.

Target Apple silicon macOS with an Apple developer toolchain, Node 22 with
matching headers, Git, Python 3 and a trusted Codex Desktop project. Test the
matching Codex CLI build independently if advertised. The release supports
local stdio, explicitly approved repository snapshots and manual refresh.
Linux, Windows, Intel macOS, the inherited web application, remote MCP and
npm distribution are outside the proposed support matrix. The inherited CLI
version is distinct from the fork's source tag.

## Acceptance criteria

Every gate must pass on the exact publication commit. Missing evidence leaves
the gate open.

| Gate | Pass criteria | Current evidence |
| --- | --- | --- |
| Public build and native prerequisites | In a clean Apple silicon account with fresh npm and extension caches, download the checked-sum source archive and clone the public tag. Verify the commit, install the two lockfiles with lifecycle scripts disabled, prepare native bindings and build the CLI without any developer files. | Partial. The public archive was reproduced byte-for-byte from the tag. CLI build, typecheck and Kotlin native rebuild passed under Node 22.23.2. Runtime smoke used copied dependencies that differed from 21 lockfile versions, including MCP SDK 1.29.0 instead of 1.32.2. An empty-cache locked install remains open. |
| FTS | Explicitly fetch the official extension using the locked native binding. Load it in an in-memory DB and confirm a keyword query on a new index returns the expected file. Without the extension, verify actionable failure and no silent runtime installation. | Provisioned cache loaded using LadybugDB 0.16.1, and real searches passed. Empty-cache load reported the extension missing. Official fetch could not connect from the audit shell. |
| First run and Codex | Use the documented setup, approval and context commands. On a new trusted Desktop project, list all eight hardened tools and use the real query tool with the intended context and repository. Remove the same project registration and confirm it disappears. | Setup, project registration, removal and a real MCP tool call through Codex App Server passed on CLI 0.170.0 and the Desktop-bundled CLI 0.171.0-alpha.13. The Desktop UI call remains open. |
| Correctness and isolation | Index two repositories containing the same symbol and use distinct paths to check attribution. Omit a third candidate from approval, reject out-of-context and unapproved queries, and check no index content changes during read-only tools. | Passed on the verified archive using two known TypeScript indexes. The third repository and wrong context were rejected. |
| Freshness and recovery | A new committed live change gives `behind` with both revisions. Run manual refresh for the exact requested commit, prove it excludes dirty changes, and verify the new connection returns the refreshed symbol and preserves the old index. Repeat with wrong HEAD or unavailable sandbox and compare old policy and index hashes. | Live freshness and policy preservation when the sandbox is unavailable passed. Real FTS refresh and rollback on a normal host remain open. Hosted refresh failure fixtures passed. |
| Sustained runtime and cleanup | On one MCP process run at least 200 mixed real calls, with zero errors or wrong attribution. For the two tiny fixture indexes use warm p95 under 1 s. Use host process tools at warm-up and completion to verify no retained DB handles, record RSS and ensure it plateaus. Require launcher and server exit after disconnect. | The launcher run passed 200/200 real queries, with warm p95 187.9 ms and max 204.4 ms. The instrumented server run passed 600/600, with warm p95 219.2 ms and RSS 389–404 MiB in the final ten samples. A separate ten-query run found zero retained DB file handles, and 400 native cycles closed and reopened successfully. These samples used the copied dependency tree. Repeat on the locked build. |
| Removal and rollback | Disconnect, remove or disable only the test project entry, and verify both the context policy and snapshots survive. Restore the previous approved snapshot from backup and prove a fresh query resolves the original revision. | Project registration removal and local file preservation passed. Successful refresh rollback remains open. |
| Supply chain and reproducibility | Green focused hosted CI, exact lockfile audit reviewed (no unresolved high/critical vulnerabilities affecting the supported path), recorded FTS provenance, and repeatable source archive with SHA256 and PolyForm Noncommercial 1.0.0 upstream notice. | Hosted Apple silicon CI passed for the merged source tree's parent. npm advisory service was unreachable from the audit shell. Licence and required upstream notice are present in the exact public archive. |

## Pull request and publication

1. After push approval, push `ap/stable-v1-readiness` and open a PR against
   `main`. Require **Source MCP CI / macOS arm64 · Node 22 · MCP** on the
   candidate commit. Review the lockfiles and check production advisories with
   `npm audit --omit=dev --prefix gitnexus` and
   `npm audit --omit=dev --prefix gitnexus-shared`. Triage the dependency chains
   against the stdio surface before changing any pins. Record the results.
2. In a fresh macOS user account or VM, follow [LOCAL_SAFE.md](LOCAL_SAFE.md)
   from the exact candidate archive with fresh npm and Ladybug caches. Use
   two harmless synthetic repositories, one duplicate symbol and one
   unapproved repository. Run the real context integration test described in
   the guide and the sustained query gate. Test refresh and rollback from a
   normal Terminal where Apple Git signature verification and the system
   sandbox work.
3. In the same clean user account, register the launcher in a disposable
   trusted Desktop project. In a fresh chat, call `gitnexus.query` on the
   duplicate symbol with the approved context and alias. Confirm the result
   contains the expected file, alias and indexed revision. Remove the
   registration, reopen the project and verify the tool disappears while the
   private policy and indexes survive.
4. After the gates pass, update the fork release references and support table
   together. Review the licence and required notices. Merge only after
   separate approval. Revalidate the exact merged tree and ensure
   `refs/tags/v1.0.0` is unused. After publication approval, create
   `git tag -a v1.0.0 REVIEWED_COMMIT -m "release v1.0.0"`.
5. Produce the source-only artefact from the annotated tag:
   `git archive --format=tar --prefix=gitnexus-codex-mcp-v1.0.0/ v1.0.0 | gzip -n > gitnexus-codex-mcp-v1.0.0.tar.gz`.
   Generate its `.sha256` with `shasum -a 256`. Extract and verify the
   licence and required notice. Push only the new tag. Stage the GitHub release
   as a draft with the archive, checksum, reviewed commit and support matrix.
   Compare the uploaded digest and smoke-test the actual public download
   before publishing as stable.

[Public source prerelease](https://github.com/anthonypaddison/gitnexus-codex-mcp/releases/tag/v0.1.0-experimental.1) ·
[Hosted source MCP CI](https://github.com/anthonypaddison/gitnexus-codex-mcp/actions/runs/44954689512)
