"""Local-safe disabled GitNexus Docker evaluation environment."""


class GitNexusDockerEnvironment:
    def __init__(self, *args, **kwargs):
        raise RuntimeError(
            "GitNexus Docker evals are disabled in the local-safe build because they install packages and run npx."
        )
