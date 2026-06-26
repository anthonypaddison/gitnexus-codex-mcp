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
