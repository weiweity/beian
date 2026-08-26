#!/usr/bin/env python3
"""Repeatable performance gates for the semantic packaging structure engine."""

from __future__ import annotations

import argparse
import json
import platform
from collections.abc import Callable
from pathlib import Path
from statistics import quantiles
import sys
from tempfile import TemporaryDirectory
from time import perf_counter
from typing import Any


PACKAGING = Path(__file__).resolve().parents[1]
if str(PACKAGING) not in sys.path:
    sys.path.insert(0, str(PACKAGING))

from structure_v2 import analyze_topology, resolve_structure_payload  # noqa: E402


def grid_structure(size: int = 70) -> dict[str, Any]:
    """Create 9,940 connected semantic edges at the default size."""
    vertices = [
        {"id": f"v-{x}-{y}", "x": x * 10.0, "y": y * 10.0}
        for y in range(size + 1)
        for x in range(size + 1)
    ]
    edges: list[dict[str, Any]] = []
    index = 0
    for y in range(size + 1):
        for x in range(size):
            index += 1
            edges.append(
                {
                    "id": f"e-{index}",
                    "start": f"v-{x}-{y}",
                    "end": f"v-{x + 1}-{y}",
                    "assignment": "cut",
                    "source_refs": [f"benchmark:{index}"],
                }
            )
    for x in range(size + 1):
        for y in range(size):
            index += 1
            edges.append(
                {
                    "id": f"e-{index}",
                    "start": f"v-{x}-{y}",
                    "end": f"v-{x}-{y + 1}",
                    "assignment": "crease",
                    "source_refs": [f"benchmark:{index}"],
                }
            )
    return {
        "schema": "packaging-structure/1",
        "units": "mm",
        "source": {
            "sha256": "f" * 64,
            "adapter": "benchmark-grid/1",
            "adapter_version": "1.0.0",
        },
        "vertices": vertices,
        "edges": edges,
        "faces": [],
        "folds": [],
        "root_face": None,
        "validation": {"status": "review_required", "errors": [], "warnings": []},
    }


def accepted_box() -> dict[str, Any]:
    width, depth, height = 30.0, 20.0, 50.0
    rectangles = {
        "back": (0.0, depth, width, depth + height),
        "left": (width, depth, width + depth, depth + height),
        "front": (width + depth, depth, 2 * width + depth, depth + height),
        "right": (2 * width + depth, depth, 2 * width + 2 * depth, depth + height),
        "top": (width + depth, depth + height, 2 * width + depth, 2 * depth + height),
        "bottom": (width + depth, 0.0, 2 * width + depth, depth),
    }
    vertex_ids: dict[tuple[float, float], str] = {}
    segment_faces: dict[tuple[tuple[float, float], tuple[float, float]], list[str]] = {}
    face_segments: dict[str, list[tuple[tuple[float, float], tuple[float, float]]]] = {}
    for role, (x0, y0, x1, y1) in rectangles.items():
        corners = ((x0, y0), (x1, y0), (x1, y1), (x0, y1))
        face_segments[role] = []
        for point in corners:
            vertex_ids.setdefault(point, f"v-{len(vertex_ids) + 1}")
        for start, end in zip(corners, corners[1:] + corners[:1]):
            segment = tuple(sorted((start, end)))
            segment_faces.setdefault(segment, []).append(role)
            face_segments[role].append(segment)
    edge_ids = {
        segment: f"e-{index}"
        for index, segment in enumerate(sorted(segment_faces), start=1)
    }
    faces = [
        {
            "id": f"face-{role}",
            "boundary": [edge_ids[segment] for segment in face_segments[role]],
            "role": role,
            "artwork_transform": [1, 0, 0, 1, -x0, -y0],
        }
        for role, (x0, y0, _x1, _y1) in rectangles.items()
    ]
    folds = [
        {
            "edge": edge_ids[segment],
            "left_face": f"face-{roles[0]}",
            "right_face": f"face-{roles[1]}",
            "angle_deg": 90,
        }
        for segment, roles in sorted(segment_faces.items())
        if len(roles) == 2
    ]
    return {
        "schema": "packaging-structure/1",
        "units": "mm",
        "source": {
            "sha256": "d" * 64,
            "adapter": "benchmark-box/1",
            "adapter_version": "1.0.0",
        },
        "vertices": [
            {"id": identity, "x": point[0], "y": point[1]}
            for point, identity in vertex_ids.items()
        ],
        "edges": [
            {
                "id": edge_ids[segment],
                "start": vertex_ids[segment[0]],
                "end": vertex_ids[segment[1]],
                "assignment": "crease" if len(roles) == 2 else "cut",
                "source_refs": [f"benchmark:{edge_ids[segment]}"],
            }
            for segment, roles in sorted(segment_faces.items())
        ],
        "faces": faces,
        "folds": folds,
        "root_face": "face-front",
        "validation": {"status": "accepted", "errors": [], "warnings": []},
    }


def percentile_95(values: list[float]) -> float:
    if len(values) == 1:
        return values[0]
    return quantiles(values, n=20, method="inclusive")[18]


def timed(callable_value: Callable[[], Any], samples: int) -> tuple[list[float], Any]:
    values: list[float] = []
    result = None
    for _ in range(samples):
        started = perf_counter()
        result = callable_value()
        values.append(perf_counter() - started)
    return values, result


def main() -> int:
    parser = argparse.ArgumentParser(description="PackagingStructure V2 performance gates")
    parser.add_argument("--topology-runs", type=int, default=7)
    parser.add_argument("--cache-runs", type=int, default=50)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.topology_runs <= 0 or args.cache_runs <= 0:
        parser.error("run counts must be positive")

    grid = grid_structure()
    analyze_topology(grid)
    topology_times, topology = timed(lambda: analyze_topology(grid), args.topology_runs)

    with TemporaryDirectory(prefix="beian-structure-cache-benchmark-") as directory:
        cache_dir = Path(directory)
        first = resolve_structure_payload(accepted_box(), cache_dir=cache_dir)
        if first.status != "ready" or first.cache_hit:
            raise RuntimeError("benchmark fixture did not prime the resolver cache")
        cache_times, cached = timed(
            lambda: resolve_structure_payload(accepted_box(), cache_dir=cache_dir),
            args.cache_runs,
        )
    if cached.status != "ready" or not cached.cache_hit:
        raise RuntimeError("benchmark fixture did not hit the resolver cache")

    topology_p95 = percentile_95(topology_times)
    cache_p95 = percentile_95(cache_times)
    report = {
        "schema": "packaging-structure-benchmark/1",
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
        },
        "topology": {
            "vertices": len(grid["vertices"]),
            "edges": len(grid["edges"]),
            "faces": topology["counts"]["faces"],
            "samples": args.topology_runs,
            "p95_s": round(topology_p95, 6),
            "limit_s": 1.0,
            "passed": topology_p95 < 1.0,
        },
        "cache": {
            "samples": args.cache_runs,
            "p95_ms": round(cache_p95 * 1000, 6),
            "limit_ms": 100.0,
            "passed": cache_p95 < 0.1,
        },
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    return 0 if report["topology"]["passed"] and report["cache"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
