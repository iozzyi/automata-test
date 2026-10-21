"""Entry point. Provided."""

from __future__ import annotations

import os

import uvicorn

from simulator.api import Config, create_app

app = create_app()


def main() -> None:
    port = int(os.environ.get("PORT", "5002"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")


if __name__ == "__main__":
    _ = Config
    main()
