"""GLB geometry and semantic artwork verification shared by Blender and L0 tests."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping, Sequence


AXIS_TO_DIMENSION = ("width", "depth", "height")
SEMANTIC_FACES = ("front", "right", "back", "left", "top", "bottom")


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


def _asset_stem(value: object) -> str:
    return Path(str(value or "")).stem.lower().split(".", 1)[0]


def compare_glb_texture_bindings(
    bindings: Mapping[str, Sequence[Mapping[str, Any]]],
    expected_assets: Mapping[str, object],
) -> dict:
    """Verify each semantic object kept its own material and source image.

    Merely finding one image somewhere in the GLB is insufficient: assigning
    ``front`` to every panel would produce a technically textured but visually
    wrong box. Blender supplies a small, serializable binding inventory here so
    this contract remains unit-testable without importing ``bpy``.
    """
    missing: list[str] = []
    mismatched: list[dict[str, object]] = []
    for face in SEMANTIC_FACES:
        candidates = list(bindings.get(face) or [])
        if not candidates:
            missing.append(face)
            continue
        expected_material = f"mat_{face}"
        expected_image = _asset_stem(expected_assets.get(face))
        matched = False
        observed: list[dict[str, object]] = []
        for candidate in candidates:
            material = str(candidate.get("material") or "").lower().split(".", 1)[0]
            images = [_asset_stem(image) for image in candidate.get("images") or []]
            observed.append({"material": material, "images": images})
            if material == expected_material and expected_image and expected_image in images:
                matched = True
        if not matched:
            mismatched.append(
                {
                    "face": face,
                    "expected_material": expected_material,
                    "expected_image": expected_image,
                    "observed": observed,
                }
            )
    return {
        "ok": not missing and not mismatched,
        "missing_faces": missing,
        "mismatched_faces": mismatched,
    }
