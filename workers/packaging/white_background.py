"""Composite transparent Blender renders onto exact white without touching opaque product pixels."""

from __future__ import annotations

import io
import os
from pathlib import Path
import tempfile

from PIL import Image


def flatten_rgba_over_white(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    return Image.alpha_composite(white, rgba).convert("RGB")


def png_bytes_over_white(path: Path | str) -> bytes:
    """RGB PNG bytes on exact white. Does not mutate the product-layer file."""
    source = Path(path).expanduser().resolve()
    with Image.open(source) as opened:
        if "A" not in opened.getbands() and opened.mode == "RGB":
            return source.read_bytes()
        result = flatten_rgba_over_white(opened)
        buffer = io.BytesIO()
        result.save(buffer, format="PNG", compress_level=3)
        return buffer.getvalue()


def composite_rgba_over_white(path: Path | str) -> None:
    source = Path(path).expanduser().resolve()
    with Image.open(source) as opened:
        result = flatten_rgba_over_white(opened)
    handle, temp_name = tempfile.mkstemp(prefix=source.name + ".", suffix=".png", dir=source.parent)
    os.close(handle)
    try:
        result.save(temp_name, format="PNG", compress_level=3)
        os.replace(temp_name, source)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise
