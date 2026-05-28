"""CLI entry point: `nsys-viewer --dir <path>`."""

from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from .server import create_app


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="nsys-viewer",
        description="Visualize and compare nsys-exported sqlite profiles.",
    )
    parser.add_argument(
        "--dir",
        "-d",
        default=".",
        help="directory containing *.sqlite files (default: cwd)",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--reload", action="store_true", help="dev mode")
    args = parser.parse_args()

    root = Path(args.dir).expanduser().resolve()
    app = create_app(root)
    print(f"nsys-viewer  root={root}  http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, reload=args.reload, log_level="info")
