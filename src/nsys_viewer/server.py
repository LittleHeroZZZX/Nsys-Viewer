"""FastAPI server for nsys-viewer."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db

WEB_DIR = Path(__file__).parent / "web"


def create_app(root: Path) -> FastAPI:
    root = root.expanduser().resolve()
    if not root.is_dir():
        raise SystemExit(f"profile root does not exist: {root}")

    app = FastAPI(title="nsys-viewer", version="0.1.0")

    def resolve_file(name: str) -> Path:
        # name is the stem (no extension). Reject anything that escapes root.
        candidate = (root / f"{name}.sqlite").resolve()
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid file") from exc
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail=f"{name}.sqlite not found")
        return candidate

    @app.get("/api/files")
    def api_files() -> JSONResponse:
        files = [
            {
                "name": f.name,
                "size_bytes": f.size_bytes,
                "mtime": f.mtime,
            }
            for f in db.list_sqlite_files(root)
        ]
        return JSONResponse({"root": str(root), "files": files})

    @app.get("/api/overview")
    def api_overview(file: str) -> JSONResponse:
        p = resolve_file(file)
        return JSONResponse(db.overview(str(p)))

    @app.get("/api/kernels")
    def api_kernels(
        file: str,
        group_by: str = Query("demangled", pattern="^(demangled|short)$"),
        limit: int = Query(200, ge=1, le=5000),
    ) -> JSONResponse:
        p = resolve_file(file)
        rows = db.kernel_summary(str(p), group_by=group_by)
        return JSONResponse({"file": file, "group_by": group_by, "rows": rows[:limit]})

    @app.get("/api/compare")
    def api_compare(
        files: str,
        group_by: str = Query("short", pattern="^(demangled|short)$"),
        limit: int = Query(200, ge=1, le=5000),
    ) -> JSONResponse:
        names = [s for s in files.split(",") if s]
        if not names:
            raise HTTPException(status_code=400, detail="files= required")
        paths = [str(resolve_file(n)) for n in names]
        data = db.compare_kernels(paths, group_by=group_by)
        data["rows"] = data["rows"][:limit]
        return JSONResponse(data)

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(WEB_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")

    return app
