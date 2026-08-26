from __future__ import annotations

from pathlib import Path
import sys

from PIL import Image
import pymupdf
import pytest


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
if str(PACKAGING) not in sys.path:
    sys.path.insert(0, str(PACKAGING))

from structure_v2 import ArtworkMappingError, render_face_assets  # noqa: E402


def resolved_fixture() -> dict:
    dimensions = {"width": 30.0, "depth": 20.0, "height": 50.0}
    regions = {
        "back": (0.0, 0.0),
        "left": (30.0, 0.0),
        "front": (50.0, 0.0),
        "right": (80.0, 0.0),
        "top": (50.0, 50.0),
        "bottom": (80.0, 50.0),
    }
    return {
        "schema": "resolved-packaging-job/1",
        "dimensions_mm": dimensions,
        "faces": {
            role: {
                "face_id": f"face-{role}",
                "artwork_transform": [1, 0, 0, 1, -x, -y],
            }
            for role, (x, y) in regions.items()
        },
    }


def artwork_pdf(path: Path) -> Path:
    mm_to_pt = 72.0 / 25.4
    document = pymupdf.open()
    page = document.new_page(width=120 * mm_to_pt, height=70 * mm_to_pt)
    # Interior dark red must survive without the former global lightening.
    page.draw_rect(
        pymupdf.Rect(50 * mm_to_pt, 0, 80 * mm_to_pt, 50 * mm_to_pt),
        color=None,
        fill=(117 / 255, 35 / 255, 46 / 255),
    )
    page.draw_rect(
        pymupdf.Rect(0, 0, 30 * mm_to_pt, 50 * mm_to_pt),
        color=None,
        fill=(0.1, 0.3, 0.8),
    )
    document.save(path)
    document.close()
    return path


def center_rgb(path: Path) -> tuple[int, int, int]:
    with Image.open(path).convert("RGB") as image:
        return image.getpixel((image.width // 2, image.height // 2))


def test_exact_affine_faces_keep_product_color_and_white_background(tmp_path: Path):
    source = artwork_pdf(tmp_path / "artwork.pdf")
    sizes = render_face_assets(source, resolved_fixture(), tmp_path / "assets", raster_width_px=1200)
    assert set(sizes) == {"front", "right", "back", "left", "top", "bottom"}
    red = center_rgb(tmp_path / "assets" / "panel_front.png")
    assert red == pytest.approx((117, 35, 46), abs=2)
    assert red[0] < 130
    assert center_rgb(tmp_path / "assets" / "panel_top.png") == (255, 255, 255)


def test_mapping_outside_artboard_fails_instead_of_cropping_wrong_panel(tmp_path: Path):
    source = artwork_pdf(tmp_path / "artwork.pdf")
    resolved = resolved_fixture()
    resolved["faces"]["front"]["artwork_transform"] = [1, 0, 0, 1, 1000, 1000]
    with pytest.raises(ArtworkMappingError) as error:
        render_face_assets(source, resolved, tmp_path / "assets", raster_width_px=1200)
    assert error.value.code == "artwork_transform_invalid"


def test_raster_size_is_bounded(tmp_path: Path):
    source = artwork_pdf(tmp_path / "artwork.pdf")
    with pytest.raises(ArtworkMappingError) as error:
        render_face_assets(source, resolved_fixture(), tmp_path / "assets", raster_width_px=100_000)
    assert error.value.code == "structure_limit_exceeded"


def test_page_raster_is_downscaled_before_allocating_excess_pixels(tmp_path: Path):
    source = artwork_pdf(tmp_path / "artwork.pdf")
    sizes = render_face_assets(
        source,
        resolved_fixture(),
        tmp_path / "assets",
        raster_width_px=10_000,
        max_raster_pixels=1_000_000,
    )
    assert sizes["front"][0] < 1_000
    assert sizes["front"][1] < 1_000
