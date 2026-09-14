#!/usr/bin/env python3
"""In-repo face probe. repo/out/case come from argv. Not a resource budget.

Importing this module does not load pymupdf or call render_face_assets.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable

STALE_WORKTREE = "worktrees/beian-r04-resource-stress"

CASES = {
    "normal": (30, 20, 50),
    "tall": (5, 5, 500),
    "wide": (500, 5, 5),
    "near-cap": (199, 5, 399),
    "exact-cap-paper": (200, 5, 400),
    "over-cap": (200, 5, 401),
    "failure-after-front": (30, 20, 50),
    "repeat": (30, 20, 50),
}

EXPECTED_ERROR = {
    "over-cap": "structure_limit_exceeded",
    "failure-after-front": "artwork_transform_invalid",
}


def expected_error_for(case: str) -> str | None:
    return EXPECTED_ERROR.get(case)


def parse_args(argv: list[str]) -> tuple[Path, Path, str]:
    if len(argv) != 3:
        raise SystemExit("usage: face_probe.py <repo> <out> <case>")
    repo, out, case = argv
    repo_path = Path(repo)
    if STALE_WORKTREE in str(repo_path):
        raise SystemExit("refuse: stale worktree path in repo argv")
    if not repo_path.is_dir():
        raise SystemExit(f"refuse: repo is not a directory: {repo_path}")
    if case not in CASES:
        raise SystemExit(f"refuse: unknown face case {case}")
    return repo_path, Path(out), case


def build_resolved(case: str) -> dict[str, Any]:
    width, depth, height = CASES[case]
    roles = {
        "front": (width, height),
        "back": (width, height),
        "left": (depth, height),
        "right": (depth, height),
        "top": (width, depth),
        "bottom": (width, depth),
    }
    faces = {
        role: {
            "artwork_layers": [
                {
                    "face_id": role,
                    "artwork_transform": [1, 0, 0, 1, 0, 0],
                    "artwork_coverage_bounds_mm": [0, 0, a, b],
                    "z_index": 0,
                }
            ]
        }
        for role, (a, b) in roles.items()
    }
    if case == "exact-cap-paper":
        faces = {role: {"paper_only": True} for role in roles}
    if case == "failure-after-front":
        faces["back"] = {}
    return {
        "schema": "resolved-packaging-job/3",
        "dimensions_mm": {"width": width, "depth": depth, "height": height},
        "faces": faces,
    }


def judge_rows(case: str, rows: list[Any]) -> dict[str, Any]:
    expected = expected_error_for(case)
    reasons: list[str] = []
    if not isinstance(rows, list) or not rows:
        reasons.append("missing_result")
    else:
        for row in rows:
            if not isinstance(row, dict):
                reasons.append("malformed_result")
                continue
            if row.get("error") != expected:
                reasons.append("error_class_mismatch")
            if "staging_left" not in row or not isinstance(row.get("staging_left"), list):
                reasons.append("cleanup_unproven")
            elif row["staging_left"]:
                reasons.append("cleanup_failed")
    ok = not reasons
    return {
        "ok": ok,
        "expected_error": expected,
        "reasons": list(dict.fromkeys(reasons)),
        "note": "expected reject exits 0 when error matches; that is behavior, not a valid resource budget",
    }


def _write_synthetic_pdf(path: Path, case: str) -> None:
    import pymupdf  # noqa: PLC0415 — runtime dependency of a real face run

    width, depth, height = CASES[case]
    doc = pymupdf.open()
    page = doc.new_page(
        width=(max(width, depth) + 10) * 72 / 25.4,
        height=(max(height, depth) + 10) * 72 / 25.4,
    )
    for index in range(60):
        y = (index + 1) * page.rect.height / 62
        page.draw_line((0, y), (page.rect.width, y), color=(0.2, 0.3, 0.8), width=0.3)
    page.insert_text((10, 20), "R04 SYNTHETIC ONLY", fontsize=8)
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(path)
    doc.close()


def _load_artwork(repo: Path) -> tuple[type, Callable[..., Any]]:
    packaging = str(repo / "workers/packaging")
    if packaging not in sys.path:
        sys.path.insert(0, packaging)
    from structure_v2.artwork import ArtworkMappingError, render_face_assets  # noqa: PLC0415

    return ArtworkMappingError, render_face_assets


def execute_case(
    repo: Path,
    out: Path,
    case: str,
    *,
    renderer: Callable[..., Any] | None = None,
    mapping_error: type[BaseException] | None = None,
    pdf_builder: Callable[[Path, str], None] | None = None,
) -> dict[str, Any]:
    out.mkdir(parents=True, exist_ok=True)
    resolved = build_resolved(case)
    (out / "fixture.json").write_text(json.dumps(resolved, indent=2), encoding="utf-8")
    pdf = out / "synthetic.pdf"
    builder = pdf_builder or _write_synthetic_pdf
    builder(pdf, case)
    error_type: type[BaseException]
    render: Callable[..., Any]
    if renderer is None:
        error_type, render = _load_artwork(repo)
    else:
        error_type = mapping_error or Exception
        render = renderer
    rows = []
    for iteration in range(8 if case == "repeat" else 1):
        started = time.monotonic()
        error = None
        sizes: dict[str, Any] = {}
        try:
            sizes = render(pdf, resolved, out / "assets", raster_width_px=256)
        except error_type as exc:
            error = getattr(exc, "code", type(exc).__name__)
        assets = out / "assets"
        staging_left = (
            [path.name for path in assets.iterdir() if path.name.startswith(".")]
            if assets.is_dir()
            else []
        )
        rows.append(
            {
                "iteration": iteration,
                "seconds": time.monotonic() - started,
                "error": error,
                "sizes": sizes,
                "staging_left": staging_left,
            }
        )
    judged = judge_rows(case, rows)
    result = {
        "case": case,
        "expected_error": judged["expected_error"],
        "ok": judged["ok"],
        "reasons": judged["reasons"],
        "repo": str(repo),
        "source_sha256": hashlib.sha256(pdf.read_bytes()).hexdigest() if pdf.is_file() else None,
        "note": judged["note"],
        "pixel_cap_note": "32MP is the single-face pixel cap, not a process memory budget",
        "rows": rows,
    }
    (out / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def main(argv: list[str] | None = None) -> int:
    repo, out, case = parse_args(list(sys.argv[1:] if argv is None else argv))
    result = execute_case(repo, out, case)
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
