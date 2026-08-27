from __future__ import annotations

import importlib.util
from pathlib import Path

from PIL import Image, ImageDraw
import pymupdf
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


def test_composite_face_recovers_artwork_misfiled_in_knife_layer():
    pipe = _load()
    print_face = Image.new("RGB", (120, 390), (122, 35, 46))
    composite_face = print_face.copy()
    draw = ImageDraw.Draw(composite_face)
    for y in range(18, 370, 28):
        draw.text((8, y), "SHINE MAGE 26F23A", fill=(255, 244, 222))
    assert pipe._prefer_composite_face(print_face, composite_face) is True

    border_only = print_face.copy()
    ImageDraw.Draw(border_only).rectangle((1, 1, 118, 388), outline=(0, 0, 0), width=2)
    assert pipe._prefer_composite_face(print_face, border_only) is False


def test_composite_face_does_not_replace_a_detailed_print_layer():
    pipe = _load()
    print_face = Image.new("RGB", (120, 390), (122, 35, 46))
    draw = ImageDraw.Draw(print_face)
    for y in range(18, 370, 28):
        draw.text((8, y), "PRINT ARTWORK", fill=(255, 244, 222))
    composite_face = print_face.copy()
    ImageDraw.Draw(composite_face).rectangle((1, 1, 118, 388), outline=(0, 0, 0), width=2)
    assert pipe._prefer_composite_face(print_face, composite_face) is False


def test_render_stroke_mask_marks_strokes_but_not_filled_artwork(tmp_path: Path):
    pipe = _load()
    doc = pymupdf.open()
    page = doc.new_page(width=100, height=100)
    page.draw_line(
        pymupdf.Point(10, 20),
        pymupdf.Point(90, 20),
        color=(1, 0, 0),
        width=1,
    )
    page.draw_rect(
        pymupdf.Rect(30, 60, 70, 90),
        color=None,
        fill=(1, 1, 1),
    )
    source = tmp_path / "knife.pdf"
    doc.save(source)
    doc.close()

    mask_path = pipe.render_stroke_mask(source, tmp_path / "mask.png", (200, 200))
    assert mask_path is not None
    with Image.open(mask_path) as mask:
        alpha = mask.getchannel("A")
        assert alpha.getpixel((100, 40)) > 200
        assert alpha.getpixel((100, 150)) == 0


def test_crop_faces_recovers_fill_artwork_without_structure_strokes(tmp_path: Path):
    pipe = _load()
    base = (122, 35, 46)
    print_image = Image.new("RGB", (200, 120), base)
    full_image = print_image.copy()
    draw = ImageDraw.Draw(full_image)
    for y in range(12, 108, 14):
        draw.rectangle((108, y, 141, y + 4), fill=(248, 237, 220))
    draw.line((100, 0, 100, 119), fill=(239, 57, 35), width=3)
    draw.line((149, 0, 149, 119), fill=(239, 57, 35), width=3)
    draw.line((100, 1, 149, 1), fill=(0, 0, 0), width=3)
    print_png = tmp_path / "print.png"
    full_png = tmp_path / "full.png"
    print_image.save(print_png)
    full_image.save(full_png)

    mask = Image.new("RGBA", full_image.size, (0, 0, 0, 0))
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.line((100, 0, 100, 119), fill=(0, 0, 0, 255), width=5)
    mask_draw.line((149, 0, 149, 119), fill=(0, 0, 0, 255), width=5)
    mask_draw.line((100, 1, 149, 1), fill=(0, 0, 0, 255), width=5)
    mask_png = tmp_path / "mask.png"
    mask.save(mask_png)

    assets = tmp_path / "assets"
    sizes = pipe.crop_faces(
        print_png,
        full_png,
        assets,
        {
            "reference_width_px": 200,
            "panel_x": [0, 50, 100, 150, 200],
            "body_top": 0,
            "body_bottom": 120,
            "dimensions_mm": {"width": 40, "depth": 40, "height": 80},
        },
        stroke_mask_png=mask_png,
    )
    assert sizes["front"] == [50, 120]
    with Image.open(assets / "panel_front.png").convert("RGB") as front:
        assert pipe._visual_detail_score(front) >= 10.0
        assert front.getpixel((0, 60)) == base
        assert front.getpixel((49, 60)) == base
        assert front.getpixel((10, 14)) == (248, 237, 220)
        assert (239, 57, 35) not in set(front.get_flattened_data())


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


def test_crop_faces_pouch_two_faces_paper_fills_sides(tmp_path: Path):
    pipe = _load()
    print_png = _png(tmp_path / "print.png")
    full_png = _png(tmp_path / "full.png")
    assets = tmp_path / "assets"
    sizes = pipe.crop_faces(
        print_png,
        full_png,
        assets,
        {
            "family": "pouch",
            "reference_width_px": 200,
            "face_boxes": {"front": [10, 10, 90, 90], "back": [100, 10, 180, 90]},
            "dimensions_mm": {"width": 40, "depth": 3, "height": 80},
        },
    )
    assert sizes["front"] == [80, 80]
    assert sizes["back"] == [80, 80]
    assert sizes["left"][0] >= 8
    assert sizes["right"][0] >= 8
    for name in ("front", "back", "left", "right", "top", "bottom"):
        assert (assets / f"panel_{name}.png").is_file()


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
