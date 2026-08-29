"""Local-safe disabled MCP bridge."""


class GitNexusMCPBridge:
    def __init__(self, *args, **kwargs):
        raise RuntimeError(
            "GitNexus MCP eval bridge is disabled in the local-safe build because the original bridge used npx."
        )
