from __future__ import annotations

import importlib.util
from pathlib import Path

from PIL import Image
import pytest

PIPE = Path(__file__).resolve().parents[4] / "workers" / "packaging" / "pipeline.py"


def _load():
    spec = importlib.util.spec_from_file_location("packaging_pipeline", PIPE)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _png(path: Path, size=(200, 100), color=(10, 20, 30)) -> Path:
    Image.new("RGB", size, color).save(path)
    return path


def test_crop_faces_panel_x_and_top_lid(tmp_path: Path):
    pipe = _load()
    print_png = _png(tmp_path / "print.png")
    full_png = _png(tmp_path / "full.png", color=(40, 50, 60))
    assets = tmp_path / "assets"
    sizes = pipe.crop_faces(
        print_png,
        full_png,
        assets,
        {
            "reference_width_px": 200,
            "panel_x": [0, 50, 100, 150, 200],
            "body_top": 10,
            "body_bottom": 90,
            "top_lid": [100, 0, 150, 10],
            "dimensions_mm": {"width": 40, "depth": 40, "height": 80},
        },
    )
    assert sizes["back"] == [50, 80]
    assert sizes["left"] == [50, 80]
    assert sizes["front"] == [50, 80]
    assert sizes["right"] == [50, 80]
    assert sizes["top"] == [50, 10]
    assert sizes["bottom"][0] >= 8
    for name in ("front", "right", "back", "left", "top", "bottom"):
        assert (assets / f"panel_{name}.png").is_file()


def test_crop_faces_face_boxes_and_paper_fill(tmp_path: Path):
    pipe = _load()
    print_png = _png(tmp_path / "print.png")
    full_png = _png(tmp_path / "full.png")
    assets = tmp_path / "assets"
    sizes = pipe.crop_faces(
        print_png,
        full_png,
        assets,
        {
            "reference_width_px": 200,
            "face_boxes": {
                "front": [10, 10, 90, 90],
                "back": [100, 10, 180, 90],
                "left": [0, 10, 10, 90],
                "right": [90, 10, 100, 90],
            },
            "dimensions_mm": {"width": 40, "depth": 10, "height": 80},
        },
    )
    assert sizes["front"] == [80, 80]
    assert sizes["back"] == [80, 80]
    assert sizes["left"] == [10, 80]
    assert sizes["right"] == [10, 80]
    assert sizes["top"][0] >= 8
    assert sizes["bottom"][0] >= 8


def test_crop_faces_missing_print_face_fails(tmp_path: Path):
    pipe = _load()
    print_png = _png(tmp_path / "print.png")
    full_png = _png(tmp_path / "full.png")
    with pytest.raises(pipe.PipelineError, match="切面不完整"):
        pipe.crop_faces(
            print_png,
            full_png,
            tmp_path / "assets",
            {
                "reference_width_px": 200,
                "face_boxes": {"front": [10, 10, 90, 90], "back": [100, 10, 180, 90]},
                "dimensions_mm": {"width": 40, "depth": 10, "height": 80},
            },
        )


def test_crop_faces_rejects_mismatched_rasters(tmp_path: Path):
    pipe = _load()
    print_png = _png(tmp_path / "print.png", size=(200, 100))
    full_png = _png(tmp_path / "full.png", size=(180, 90))
    with pytest.raises(pipe.PipelineError, match="尺寸不一致"):
        pipe.crop_faces(print_png, full_png, tmp_path / "assets", {"reference_width_px": 200, "panel_x": [0, 1, 2, 3, 4], "body_top": 0, "body_bottom": 10})
