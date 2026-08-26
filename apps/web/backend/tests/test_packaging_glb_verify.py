from __future__ import annotations

import importlib.util
from pathlib import Path


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
