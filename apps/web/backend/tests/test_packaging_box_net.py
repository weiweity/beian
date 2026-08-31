from __future__ import annotations

from pathlib import Path
import re
import sys

import pytest


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
if str(PACKAGING) not in sys.path:
    sys.path.insert(0, str(PACKAGING))

from structure_v2.box_net import (  # noqa: E402
    BoxNetProposalLimitError,
    derive_box_net_proposals,
)


def rectangle(identity: str, bounds: tuple[float, float, float, float]) -> dict:
    return {"id": identity, "local_bounds": bounds}


def horizontal_net(
    prefix: str,
    *,
    origin_x: float = 0.0,
    origin_y: float = 0.0,
    width: float = 30.0,
    depth: float = 20.0,
    height: float = 50.0,
) -> list[dict]:
    x0 = origin_x
    y0 = origin_y + depth
    body_widths = (width, depth, width, depth)
    body: list[dict] = []
    for index, panel_width in enumerate(body_widths, start=1):
        body.append(rectangle(f"{prefix}-body-{index}", (x0, y0, x0 + panel_width, y0 + height)))
        x0 += panel_width
    return [
        *body,
        rectangle(f"{prefix}-cap-top", (origin_x, origin_y, origin_x + width, origin_y + depth)),
        rectangle(
            f"{prefix}-cap-bottom",
            (origin_x, y0 + height, origin_x + width, y0 + height + depth),
        ),
    ]


def vertical_net(prefix: str, *, origin_x: float = 0.0, origin_y: float = 0.0) -> list[dict]:
    width, depth, height = 30.0, 20.0, 50.0
    x0 = origin_x + depth
    y0 = origin_y
    body_heights = (width, depth, width, depth)
    body: list[dict] = []
    for index, panel_height in enumerate(body_heights, start=1):
        body.append(rectangle(f"{prefix}-body-{index}", (x0, y0, x0 + height, y0 + panel_height)))
        y0 += panel_height
    return [
        *body,
        rectangle(f"{prefix}-cap-left", (origin_x, origin_y, origin_x + depth, origin_y + width)),
        rectangle(
            f"{prefix}-cap-right",
            (x0 + height, origin_y, x0 + height + depth, origin_y + width),
        ),
    ]


def test_groups_a_horizontal_carton_and_excludes_unrelated_rectangles():
    candidates = [
        *horizontal_net("main"),
        rectangle("nested-note", (5.0, 30.0, 15.0, 40.0)),
        rectangle("reference-box", (300.0, 300.0, 310.0, 310.0)),
    ]

    proposals = derive_box_net_proposals(candidates)

    assert len(proposals) == 1
    proposal = proposals[0]
    assert re.fullmatch(r"box-net-[0-9a-f]{16}", proposal["id"])
    assert proposal["strip_axis"] == "x"
    assert proposal["body_face_ids"] == [f"main-body-{index}" for index in range(1, 5)]
    assert proposal["cap_face_ids"] == ["main-cap-top", "main-cap-bottom"]
    assert set(proposal["face_ids"]) == {
        *(f"main-body-{index}" for index in range(1, 5)),
        "main-cap-top",
        "main-cap-bottom",
    }
    assert proposal["bounds_mm"] == [0.0, 0.0, 100.0, 90.0]
    assert "_rank" not in proposal


def test_groups_a_vertical_carton_without_assuming_a_horizontal_dieline():
    proposals = derive_box_net_proposals(vertical_net("vertical"))

    assert len(proposals) == 1
    proposal = proposals[0]
    assert proposal["strip_axis"] == "y"
    assert proposal["body_face_ids"] == [f"vertical-body-{index}" for index in range(1, 5)]
    assert proposal["cap_face_ids"] == ["vertical-cap-left", "vertical-cap-right"]
    assert proposal["bounds_mm"] == [0.0, 0.0, 90.0, 100.0]


def test_rejects_partial_or_dimensionally_incoherent_sets():
    incomplete = horizontal_net("partial")[:-1]
    incoherent = horizontal_net("bad")
    incoherent[3]["local_bounds"] = (80.0, 20.0, 105.0, 70.0)

    assert derive_box_net_proposals(incomplete) == []
    assert derive_box_net_proposals(incoherent) == []


def test_tolerance_accepts_small_export_gaps_but_not_large_ones():
    close_enough = horizontal_net("close")
    close_enough[1]["local_bounds"] = (30.4, 20.0, 50.4, 70.0)
    close_enough[2]["local_bounds"] = (50.4, 20.0, 80.4, 70.0)
    close_enough[3]["local_bounds"] = (80.4, 20.0, 100.4, 70.0)

    too_far = horizontal_net("far")
    too_far[1]["local_bounds"] = (34.0, 20.0, 54.0, 70.0)

    assert len(derive_box_net_proposals(close_enough)) == 1
    assert derive_box_net_proposals(too_far) == []


def test_boundary_tolerance_does_not_grow_with_the_artboard_origin():
    connected = horizontal_net("translated", origin_x=1000.0)
    disconnected = horizontal_net("offset-gap", origin_x=1000.0)
    for face in disconnected[1:4]:
        left, top, right, bottom = face["local_bounds"]
        face["local_bounds"] = (left + 20.0, top, right + 20.0, bottom)

    assert len(derive_box_net_proposals(connected)) == 1
    assert derive_box_net_proposals(disconnected) == []


def test_ranks_larger_complete_nets_first_with_stable_public_ids():
    small = horizontal_net("small", origin_x=1000.0, width=20.0, depth=10.0, height=30.0)
    large = horizontal_net("large", width=40.0, depth=25.0, height=60.0)

    proposals = derive_box_net_proposals([*small, *large])

    repeated = derive_box_net_proposals([*small, *large])

    assert [proposal["id"] for proposal in proposals] == [proposal["id"] for proposal in repeated]
    assert len({proposal["id"] for proposal in proposals}) == 2
    assert all(re.fullmatch(r"box-net-[0-9a-f]{16}", proposal["id"]) for proposal in proposals)
    assert all(face_id.startswith("large-") for face_id in proposals[0]["face_ids"])
    assert all(face_id.startswith("small-") for face_id in proposals[1]["face_ids"])


def test_binds_public_ids_to_source_and_coordinate_basis():
    candidates = horizontal_net("bound")

    original = derive_box_net_proposals(candidates, binding_seed="source-a")[0]["id"]
    changed_source = derive_box_net_proposals(candidates, binding_seed="source-b")[0]["id"]
    changed_basis = derive_box_net_proposals(
        candidates,
        binding_seed="source-a",
        basis_transform=(0.0, -1.0, 1.0, 0.0, 0.0, 0.0),
    )[0]["id"]

    assert len({original, changed_source, changed_basis}) == 3


def test_accepts_normal_main_panel_clearance_but_rejects_a_short_flap():
    clearance = horizontal_net("closure-clearance")
    clearance[4]["local_bounds"] = (0.0, 1.2, 30.0, 20.0)

    proposals = derive_box_net_proposals(clearance)

    assert len(proposals) == 1
    closures = proposals[0]["closure_assemblies"]
    assert [closure["extent"] for closure in closures] == ["partial", "full"]
    assert closures[0]["coverage_ratio"] == 0.94

    short = horizontal_net("short-flap")
    short[4]["local_bounds"] = (0.0, 12.0, 30.0, 20.0)
    assert derive_box_net_proposals(short) == []


def test_proposal_dimensions_use_the_same_opposite_panel_averages_as_final_resolution():
    candidates = [
        rectangle("drift-body-1", (0.0, 20.0, 30.0, 70.0)),
        rectangle("drift-body-2", (30.0, 20.0, 50.0, 70.0)),
        rectangle("drift-body-3", (50.0, 20.0, 79.0, 70.0)),
        rectangle("drift-body-4", (79.0, 20.0, 98.0, 70.0)),
        rectangle("drift-cap-top", (0.0, 0.0, 30.0, 20.0)),
        rectangle("drift-cap-bottom", (0.0, 70.0, 30.0, 90.0)),
    ]

    proposal = derive_box_net_proposals(candidates)[0]

    assert proposal["dimensions_mm"] == {"width": 29.5, "depth": 19.5, "height": 50.0}


def test_dust_flap_attached_to_a_side_panel_cannot_swap_width_and_depth():
    candidates = horizontal_net("side-dust")
    candidates[4] = rectangle("side-dust-cap-top", (30.0, 12.0, 50.0, 20.0))

    assert derive_box_net_proposals(candidates) == []


def test_fails_closed_when_whole_net_choices_exceed_the_review_limit():
    candidates = [
        candidate
        for index in range(25)
        for candidate in horizontal_net(f"net-{index:02d}", origin_x=index * 1000.0)
    ]

    with pytest.raises(BoxNetProposalLimitError, match="超过上限：25"):
        derive_box_net_proposals(candidates)


def test_deduplicates_identical_rectangles_before_search():
    candidates = [
        rectangle(
            f"body-{panel_index}-{copy_index}",
            (left, 20.0, left + width, 70.0),
        )
        for panel_index, (left, width) in enumerate(
            ((0.0, 30.0), (30.0, 20.0), (50.0, 30.0), (80.0, 20.0)),
        )
        for copy_index in range(10)
    ]
    candidates.extend(
        [
            rectangle("cap-top", (0.0, 0.0, 30.0, 20.0)),
            rectangle("cap-bottom", (0.0, 70.0, 30.0, 90.0)),
        ]
    )

    proposals = derive_box_net_proposals(candidates)

    assert len(proposals) == 1


def test_fails_closed_before_near_duplicate_rectangles_expand_combinatorially():
    candidates = [
        rectangle(
            f"body-{panel_index}-{copy_index}",
            (left + copy_index * 0.05, 20.0, left + width + copy_index * 0.05, 70.0),
        )
        for panel_index, (left, width) in enumerate(
            ((0.0, 30.0), (30.0, 20.0), (50.0, 30.0), (80.0, 20.0)),
        )
        for copy_index in range(10)
    ]

    with pytest.raises(BoxNetProposalLimitError, match="搜索超过上限"):
        derive_box_net_proposals(candidates)
