"""Axis-aware GLB dimension verification shared by Blender and L0 tests."""

from __future__ import annotations

from typing import Mapping, Sequence


AXIS_TO_DIMENSION = ("width", "depth", "height")


def compare_glb_dimensions(
    measured_xyz_metres: Sequence[float],
    dimensions_mm: Mapping[str, float],
    tolerance_mm: float,
) -> dict:
    if len(measured_xyz_metres) != 3:
        raise ValueError("GLB measured dimensions must be X/Y/Z")
    measured = {
        name: float(measured_xyz_metres[index]) * 1000.0
        for index, name in enumerate(AXIS_TO_DIMENSION)
    }
    expected = {name: float(dimensions_mm[name]) for name in AXIS_TO_DIMENSION}
    errors = {name: abs(measured[name] - expected[name]) for name in AXIS_TO_DIMENSION}
    return {
        "ok": max(errors.values()) <= float(tolerance_mm),
        "measured_mm": measured,
        "expected_mm": expected,
        "error_mm": errors,
        "tolerance_mm": float(tolerance_mm),
    }
