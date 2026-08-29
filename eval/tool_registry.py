"""Local-safe disabled GitNexus eval tool registry."""


def get_tool_registry(*args, **kwargs):
    raise RuntimeError(
        "GitNexus eval tool registry is disabled in the local-safe build because the original fallbacks used npx."
    )
