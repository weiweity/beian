"""Shared dimensional policy for PackagingStructure V2.

Exact semantic structure and Illustrator stroke proposals have different
measurement guarantees. Keep that distinction in one place so proposal,
human confirmation, and final resolution cannot accept and reject the same
carton with different tolerances.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


STROKE_PROPOSAL_ADAPTER = "illustrator-stroke-proposal/1"


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
