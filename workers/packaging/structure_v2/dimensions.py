"""Shared dimensional policy for PackagingStructure V2.

Exact semantic structure and Illustrator stroke proposals have different
measurement guarantees. Keep that distinction in one place so proposal,
human confirmation, and final resolution cannot accept and reject the same
carton with different tolerances.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any


STROKE_PROPOSAL_ADAPTER = "illustrator-stroke-proposal/1"
MEASUREMENT_DECIMALS = 3


def normalized_mm(value: float) -> float:
    """Remove sub-micron coordinate noise before dimensions cross a boundary."""
    result = round(float(value), MEASUREMENT_DECIMALS)
    return 0.0 if result == -0.0 else result


@dataclass(frozen=True)
class DimensionPolicy:
    absolute_mm: float
    relative: float

    def close(self, left: float, right: float) -> bool:
        return abs(left - right) <= max(
            self.absolute_mm,
            max(abs(left), abs(right)) * self.relative,
        )


@dataclass(frozen=True)
class GeometryPolicy:
    """One adapter-owned policy for proposal geometry and final dimensions."""

    boundary_mm: float | None
    dimensions: DimensionPolicy


STRICT_GEOMETRY = GeometryPolicy(
    boundary_mm=None,
    dimensions=DimensionPolicy(absolute_mm=0.1, relative=0.001),
)
# Illustrator dielines commonly contain duplicated cut/crease strokes or flap
# clearance in the 0.5-1.5 mm range. This policy is intentionally restricted
# to the human-confirmed stroke proposal adapter.
STROKE_PROPOSAL_GEOMETRY = GeometryPolicy(
    boundary_mm=1.5,
    dimensions=DimensionPolicy(absolute_mm=1.5, relative=0.03),
)


def is_stroke_proposal_source(source: Mapping[str, Any] | None) -> bool:
    return bool(source and source.get("adapter") == STROKE_PROPOSAL_ADAPTER)


def geometry_policy_for_source(source: Mapping[str, Any] | None) -> GeometryPolicy:
    return STROKE_PROPOSAL_GEOMETRY if is_stroke_proposal_source(source) else STRICT_GEOMETRY


def solve_body_dimensions(
    face_sizes: Mapping[str, Sequence[float]],
    policy: DimensionPolicy,
) -> dict[str, float] | None:
    """Solve one physical box size from four oriented body panels.

    Proposal grouping, human-anchor confirmation, and the final resolver all
    call this function.  Keeping the opposite-face averages here prevents a
    proposal from advertising one size while the approved GLB uses another.
    """
    if set(face_sizes) != {"front", "right", "back", "left"}:
        return None
    if any(len(face_sizes[role]) != 2 for role in ("front", "right", "back", "left")):
        return None
    groups = {
        "width": [float(face_sizes["front"][0]), float(face_sizes["back"][0])],
        "depth": [float(face_sizes["left"][0]), float(face_sizes["right"][0])],
        "height": [float(face_sizes[role][1]) for role in ("front", "right", "back", "left")],
    }
    dimensions: dict[str, float] = {}
    for name, values in groups.items():
        anchor = values[0]
        if not all(policy.close(anchor, value) for value in values[1:]):
            return None
        dimensions[name] = normalized_mm(sum(values) / len(values))
    return dimensions
