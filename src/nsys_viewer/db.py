"""Read-only query layer over nsys-exported sqlite files."""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class FileInfo:
    name: str
    path: str
    size_bytes: int
    mtime: float


def list_sqlite_files(root: Path) -> list[FileInfo]:
    items: list[FileInfo] = []
    for p in sorted(root.glob("*.sqlite")):
        st = p.stat()
        items.append(FileInfo(name=p.stem, path=str(p), size_bytes=st.st_size, mtime=st.st_mtime))
    return items


def _open(path: Path) -> sqlite3.Connection:
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _filter_by_regex(rows: list[dict[str, Any]], pattern: str) -> list[dict[str, Any]]:
    if not pattern:
        return rows
    try:
        rx = re.compile(pattern, re.IGNORECASE)
        return [r for r in rows if rx.search(r["name"])]
    except re.error:
        return rows


def _has_table(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


@lru_cache(maxsize=64)
def overview(path_str: str) -> dict[str, Any]:
    path = Path(path_str)
    with _open(path) as conn:
        info: dict[str, Any] = {
            "file": path.stem,
            "path": str(path),
            "size_bytes": path.stat().st_size,
        }
        if _has_table(conn, "CUPTI_ACTIVITY_KIND_KERNEL"):
            row = conn.execute(
                """
                SELECT COUNT(*) AS cnt,
                       COALESCE(SUM(end - start), 0) AS total_ns,
                       MIN(start) AS first_ns,
                       MAX(end)   AS last_ns
                FROM CUPTI_ACTIVITY_KIND_KERNEL
                """
            ).fetchone()
            info["kernel_count"] = row["cnt"]
            info["kernel_total_ns"] = row["total_ns"]
            info["first_ns"] = row["first_ns"]
            info["last_ns"] = row["last_ns"]
            info["wall_ns"] = (
                (row["last_ns"] - row["first_ns"]) if row["first_ns"] is not None else 0
            )
        else:
            info["kernel_count"] = 0
            info["kernel_total_ns"] = 0
            info["wall_ns"] = 0

        if _has_table(conn, "CUPTI_ACTIVITY_KIND_MEMCPY"):
            row = conn.execute(
                "SELECT COUNT(*) AS cnt, COALESCE(SUM(end - start), 0) AS total_ns "
                "FROM CUPTI_ACTIVITY_KIND_MEMCPY"
            ).fetchone()
            info["memcpy_count"] = row["cnt"]
            info["memcpy_total_ns"] = row["total_ns"]

        if _has_table(conn, "TARGET_INFO_GPU"):
            row = conn.execute("SELECT * FROM TARGET_INFO_GPU LIMIT 1").fetchone()
            if row is not None:
                keys = row.keys()
                for col in ("name", "computeCapabilityMajor", "computeCapabilityMinor"):
                    if col in keys:
                        info[f"gpu_{col}"] = row[col]
        return info


@lru_cache(maxsize=64)
def kernel_summary(path_str: str, group_by: str = "demangled") -> list[dict[str, Any]]:
    """Return aggregated kernel rows, sorted by total_ns desc.

    group_by: 'demangled' uses the fully-qualified template name; 'short' collapses
    to the function name (template args dropped) which is friendlier for compare.
    """
    name_col = {"demangled": "demangledName", "short": "shortName"}[group_by]
    path = Path(path_str)
    with _open(path) as conn:
        if not _has_table(conn, "CUPTI_ACTIVITY_KIND_KERNEL"):
            return []
        rows = conn.execute(
            f"""
            SELECT s.value AS name,
                   COUNT(*) AS cnt,
                   SUM(k.end - k.start)  AS total_ns,
                   AVG(k.end - k.start)  AS avg_ns,
                   MIN(k.end - k.start)  AS min_ns,
                   MAX(k.end - k.start)  AS max_ns
            FROM CUPTI_ACTIVITY_KIND_KERNEL k
            JOIN StringIds s ON k.{name_col} = s.id
            GROUP BY k.{name_col}
            ORDER BY total_ns DESC
            """
        ).fetchall()
        total_ns = sum(r["total_ns"] for r in rows) or 1
        return [
            {
                "name": r["name"],
                "cnt": r["cnt"],
                "total_ns": r["total_ns"],
                "avg_ns": r["avg_ns"],
                "min_ns": r["min_ns"],
                "max_ns": r["max_ns"],
                "pct": r["total_ns"] / total_ns,
            }
            for r in rows
        ]


def compare_kernels(
    path_strs: list[str], group_by: str = "short", filters: list[str] | None = None
) -> dict[str, Any]:
    """Build a side-by-side comparison.

    Returns:
        {
          "files":   [stem, ...],            # column order
          "rows":    [{name, totals:[ns,...], counts:[n,...], avgs:[ns,...]}],
          "totals":  [sum_total_ns_per_file],
        }
    """
    per_file: list[dict[str, dict[str, Any]]] = []
    file_names: list[str] = []
    for i, p in enumerate(path_strs):
        summary = kernel_summary(p, group_by=group_by)
        pattern = filters[i] if filters and i < len(filters) else ""
        if pattern:
            summary = _filter_by_regex(summary, pattern)
        per_file.append({r["name"]: r for r in summary})
        file_names.append(Path(p).stem)

    all_names: set[str] = set()
    for d in per_file:
        all_names.update(d.keys())

    rows: list[dict[str, Any]] = []
    for name in all_names:
        totals = [d.get(name, {}).get("total_ns", 0) for d in per_file]
        counts = [d.get(name, {}).get("cnt", 0) for d in per_file]
        avgs = [d.get(name, {}).get("avg_ns", 0) for d in per_file]
        rows.append(
            {
                "name": name,
                "totals": totals,
                "counts": counts,
                "avgs": avgs,
                "max_total": max(totals),
            }
        )
    rows.sort(key=lambda r: r["max_total"], reverse=True)
    file_totals = [sum(d[n]["total_ns"] for n in d) for d in per_file]
    return {"files": file_names, "rows": rows, "totals": file_totals}
