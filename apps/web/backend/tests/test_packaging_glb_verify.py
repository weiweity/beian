from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


MODULE = Path(__file__).resolve().parents[4] / "workers" / "packaging" / "glb_verify.py"


def glb_verify():
    spec = importlib.util.spec_from_file_location("packaging_glb_verify", MODULE)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_axis_dimensions_pass_with_small_export_tolerance():
    report = glb_verify().compare_glb_dimensions(
        [0.03013, 0.02013, 0.05013],
        {"width": 30, "depth": 20, "height": 50},
        0.5,
    )
    assert report["ok"] is True
    assert report["measured_mm"]["width"] == 30.13


def test_width_depth_swap_fails_even_when_sorted_dimensions_match():
    report = glb_verify().compare_glb_dimensions(
        [0.02013, 0.03013, 0.05013],
        {"width": 30, "depth": 20, "height": 50},
        0.5,
    )
    assert report["ok"] is False
    assert report["error_mm"]["width"] > 9
    assert sorted(report["measured_mm"].values()) == sorted([20.13, 30.13, 50.13])


def _bindings():
    return {
        face: [{"material": f"MAT_{face}", "images": [f"panel_{face}"]}]
        for face in glb_verify().SEMANTIC_FACES
    }


def _assets():
    return {face: f"/tmp/panel_{face}.png" for face in glb_verify().SEMANTIC_FACES}


def test_all_six_semantic_faces_require_their_exact_artwork_binding():
    report = glb_verify().compare_glb_texture_bindings(_bindings(), _assets())

    assert report == {"ok": True, "missing_faces": [], "mismatched_faces": []}


@pytest.mark.parametrize("face", glb_verify().SEMANTIC_FACES)
def test_each_missing_semantic_face_fails_closed(face: str):
    bindings = _bindings()
    del bindings[face]

    report = glb_verify().compare_glb_texture_bindings(bindings, _assets())

    assert report["ok"] is False
    assert report["missing_faces"] == [face]


def test_reusing_front_artwork_on_another_face_is_rejected():
    bindings = _bindings()
    bindings["back"] = [{"material": "MAT_back", "images": ["panel_front"]}]

    report = glb_verify().compare_glb_texture_bindings(bindings, _assets())

    assert report["ok"] is False
    assert report["mismatched_faces"][0]["face"] == "back"


def test_wrong_semantic_material_is_rejected_even_with_the_right_image():
    bindings = _bindings()
    bindings["bottom"] = [{"material": "MAT_top", "images": ["panel_bottom"]}]

    report = glb_verify().compare_glb_texture_bindings(bindings, _assets())

    assert report["ok"] is False
    assert report["mismatched_faces"][0]["face"] == "bottom"
