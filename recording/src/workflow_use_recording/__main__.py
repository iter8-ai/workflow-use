from __future__ import annotations

import os

import uvicorn


def runtime_settings() -> tuple[str, int, int]:
    host = os.environ.get("WORKFLOW_USE_HOST", "127.0.0.1")
    port = int(os.environ.get("WORKFLOW_USE_PORT", "8090"))
    return host, port, 1


def main() -> None:
    host, port, workers = runtime_settings()
    uvicorn.run(
        "workflow_use_recording.api:create_default_app",
        factory=True,
        host=host,
        port=port,
        workers=workers,
    )


if __name__ == "__main__":
    main()
