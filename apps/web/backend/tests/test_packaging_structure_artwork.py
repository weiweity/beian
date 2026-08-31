from __future__ import annotations

from pathlib import Path
import sys

from PIL import Image
import pymupdf
import pytest


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
RENDER_JOB = PACKAGING / "blender" / "render_job.py"
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
        "schema": "resolved-packaging-job/3",
        "dimensions_mm": dimensions,
        "faces": {
            role: {
                "face_id": f"face-{role}",
                "artwork_layers": [
                    {
                        "face_id": f"face-{role}",
                        "artwork_transform": [1, 0, 0, 1, -x, -y],
                        "artwork_coverage_bounds_mm": [
                            0.0,
                            0.0,
                            dimensions["width"] if role in {"front", "back", "top", "bottom"} else dimensions["depth"],
                            dimensions["height"] if role in {"front", "back", "left", "right"} else dimensions["depth"],
                        ],
                        "z_index": 0,
                    }
                ],
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


def center_rgba(path: Path) -> tuple[int, int, int, int]:
    with Image.open(path).convert("RGBA") as image:
        return image.getpixel((image.width // 2, image.height // 2))


def test_exact_affine_faces_keep_product_color_and_unpainted_pdf_alpha(tmp_path: Path):
    source = artwork_pdf(tmp_path / "artwork.pdf")
    sizes = render_face_assets(source, resolved_fixture(), tmp_path / "assets", raster_width_px=1200)
    assert set(sizes) == {"front", "right", "back", "left", "top", "bottom"}
    red = center_rgb(tmp_path / "assets" / "panel_front.png")
    assert red == pytest.approx((117, 35, 46), abs=2)
    assert red[0] < 130
    assert center_rgba(tmp_path / "assets" / "panel_top.png") == (0, 0, 0, 0)


def test_unpainted_pixels_inside_full_physical_coverage_remain_transparent(tmp_path: Path):
    source = artwork_pdf(tmp_path / "artwork.pdf")

    render_face_assets(source, resolved_fixture(), tmp_path / "assets", raster_width_px=1200)

    with Image.open(tmp_path / "assets" / "panel_top.png").convert("RGBA") as image:
        assert image.getpixel((image.width // 2, image.height // 2))[3] == 0


def test_closure_clearance_emits_alpha_mask_without_stretching_adjacent_artwork(tmp_path: Path):
    mm_to_pt = 72.0 / 25.4
    source = tmp_path / "closure-clearance.pdf"
    document = pymupdf.open()
    page = document.new_page(width=120 * mm_to_pt, height=70 * mm_to_pt)
    # The blue strip sits outside the real closure panel. If the old whole-face
    # inverse crop returns, it leaks into the 3D top instead of being padded.
    page.draw_rect(
        pymupdf.Rect(50 * mm_to_pt, 50 * mm_to_pt, 80 * mm_to_pt, 51.2 * mm_to_pt),
        color=None,
        fill=(0.0, 0.0, 1.0),
    )
    page.draw_rect(
        pymupdf.Rect(50 * mm_to_pt, 51.2 * mm_to_pt, 80 * mm_to_pt, 70 * mm_to_pt),
        color=None,
        fill=(117 / 255, 35 / 255, 46 / 255),
    )
    document.save(source)
    document.close()
    resolved = resolved_fixture()
    resolved["faces"]["top"]["artwork_layers"][0]["artwork_coverage_bounds_mm"] = [0.0, 1.2, 30.0, 20.0]

    render_face_assets(source, resolved, tmp_path / "assets", raster_width_px=1200)

    with Image.open(tmp_path / "assets" / "panel_top.png").convert("RGBA") as image:
        assert image.getpixel((image.width // 2, 1))[3] == 0
        assert image.getpixel((image.width // 2, image.height // 2)) == pytest.approx((117, 35, 46, 255), abs=2)


def test_opposing_closure_layers_compose_without_white_padding(tmp_path: Path):
    mm_to_pt = 72.0 / 25.4
    source = tmp_path / "assembled-closure.pdf"
    document = pymupdf.open()
    page = document.new_page(width=120 * mm_to_pt, height=70 * mm_to_pt)
    page.draw_rect(
        pymupdf.Rect(50 * mm_to_pt, 50 * mm_to_pt, 80 * mm_to_pt, 60 * mm_to_pt),
        color=None,
        fill=(117 / 255, 35 / 255, 46 / 255),
    )
    page.draw_rect(
        pymupdf.Rect(0, 50 * mm_to_pt, 30 * mm_to_pt, 60 * mm_to_pt),
        color=None,
        fill=(0.1, 0.3, 0.8),
    )
    document.save(source)
    document.close()
    resolved = resolved_fixture()
    resolved["faces"]["top"]["artwork_layers"] = [
        {
            "face_id": "face-top-front",
            "artwork_transform": [1, 0, 0, 1, -50, -50],
            "artwork_coverage_bounds_mm": [0.0, 0.0, 30.0, 10.0],
            "z_index": 0,
        },
        {
            "face_id": "face-top-back",
            "artwork_transform": [1, 0, 0, 1, 0, -40],
            "artwork_coverage_bounds_mm": [0.0, 10.0, 30.0, 20.0],
            "z_index": 1,
        },
    ]

    render_face_assets(source, resolved, tmp_path / "assets", raster_width_px=1200)

    with Image.open(tmp_path / "assets" / "panel_top.png").convert("RGB") as image:
        assert image.getpixel((image.width // 2, image.height // 4)) == pytest.approx((117, 35, 46), abs=2)
        assert image.getpixel((image.width // 2, image.height * 3 // 4)) == pytest.approx((26, 76, 204), abs=2)


def test_blender_uses_the_artwork_alpha_as_a_binary_mask_over_the_opaque_core():
    source = RENDER_JOB.read_text(encoding="utf-8")

    assert 'alpha_mask = nodes.new("ShaderNodeMath")' in source
    assert 'alpha_mask.operation = "ROUND"' in source
    assert 'links.new(texture.outputs["Alpha"], alpha_mask.inputs[0])' in source
    assert 'links.new(alpha_mask.outputs[0], shader.inputs["Alpha"])' in source
    assert 'material.blend_method = "CLIP"' in source
    assert 'core.data.materials.append(make_core_material(substrate_rgba))' in source
    assert "compare_glb_material_contract(" in source
    assert "load_glb_json(" in source


def test_legacy_resolved_contract_is_rejected_for_recomputation(tmp_path: Path):
    source = artwork_pdf(tmp_path / "artwork.pdf")
    resolved = resolved_fixture()
    resolved["schema"] = "resolved-packaging-job/1"

    with pytest.raises(ArtworkMappingError) as error:
        render_face_assets(source, resolved, tmp_path / "assets", raster_width_px=1200)

    assert error.value.code == "structure_schema_unsupported"


def test_mapping_outside_artboard_fails_instead_of_cropping_wrong_panel(tmp_path: Path):
    source = artwork_pdf(tmp_path / "artwork.pdf")
    resolved = resolved_fixture()
    resolved["faces"]["front"]["artwork_layers"][0]["artwork_transform"] = [1, 0, 0, 1, 1000, 1000]
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
