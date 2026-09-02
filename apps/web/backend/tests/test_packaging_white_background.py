from __future__ import annotations

import importlib.util
from pathlib import Path

from PIL import Image


MODULE = Path(__file__).resolve().parents[4] / "workers" / "packaging" / "white_background.py"


def white_background():
    spec = importlib.util.spec_from_file_location("packaging_white_background", MODULE)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_transparent_pixels_become_exact_white_and_opaque_product_is_unchanged(tmp_path: Path):
    path = tmp_path / "render.png"
    image = Image.new("RGBA", (3, 1), (0, 0, 0, 0))
    image.putpixel((1, 0), (117, 35, 46, 255))
    image.putpixel((2, 0), (117, 35, 46, 128))
    image.save(path)

    white_background().composite_rgba_over_white(path)

    with Image.open(path).convert("RGB") as result:
        assert result.getpixel((0, 0)) == (255, 255, 255)
        assert result.getpixel((1, 0)) == (117, 35, 46)
        assert result.getpixel((2, 0)) == (186, 145, 150)


def test_pipeline_keeps_blender_stills_as_product_layer():
    source = (Path(__file__).resolve().parents[4] / "workers" / "packaging" / "pipeline.py").read_text(
        encoding="utf-8"
    )
    assert "composite_rgba_over_white(output)" not in source
    assert "png_bytes_over_white" in source


def test_png_bytes_over_white_does_not_mutate_the_product_layer(tmp_path: Path):
    from io import BytesIO

    path = tmp_path / "product.png"
    image = Image.new("RGBA", (2, 1), (0, 0, 0, 0))
    image.putpixel((1, 0), (117, 35, 46, 255))
    image.save(path)
    before = path.read_bytes()

    payload = white_background().png_bytes_over_white(path)

    assert path.read_bytes() == before
    with Image.open(BytesIO(payload)).convert("RGB") as result:
        assert result.getpixel((0, 0)) == (255, 255, 255)
        assert result.getpixel((1, 0)) == (117, 35, 46)
