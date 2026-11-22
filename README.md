# GitNexus for Codex — experimental fork

A source-available fork of [GitNexus](https://github.com/abhigyanpatwari/GitNexus)
by Abhigyan Patwari and the upstream contributors. This independent fork has no
upstream endorsement.

The experimental release supports one local, stdio MCP server for explicitly
approved repositories. It offers named contexts, read-only code search and
impact tools, live index freshness, and an explicit manual snapshot refresh.
The installation guide covers project-scoped registration in Codex Desktop
without a global configuration change.

- [Install, configure, and remove the integration](LOCAL_SAFE.md)
- [Experimental release notes](#experimental-prerelease)
- [Stable release gates](STABLE_READINESS.md)
- [Security reporting and scope](SECURITY.md)
- [Licence and required upstream notice](LICENSE)

## Experimental prerelease

[Published source tag `v0.1.0-experimental.1`](https://github.com/anthonypaddison/gitnexus-codex-mcp/releases/tag/v0.1.0-experimental.1).
The local CLI still reports the
inherited GitNexus version `1.6.5`; use the Git tag and commit to identify the fork
build. There is no fork npm release, container image, or hosted service.
Installation requires an explicit dependency install and a compatible local
LadybugDB FTS extension. The hardened MCP does not download packages or
extensions at runtime, or refresh indexes while answering queries.

The supported trial is Apple silicon macOS with Node 22 and a trusted Codex
Desktop project. Linux and Windows have no release acceptance. Indexes contain
repository data. Select only repositories you can index locally and share with
your chosen Codex session.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE) permits redistribution of permitted
modifications subject to its terms and required notices. Personal
experimentation without anticipated commercial application is an example of a
permitted use. Review the licence before commercial, employer, or client use;
this fork provides no additional permissions. Keep the licence and required
upstream notice with any copy you redistribute.
