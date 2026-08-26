"""Composite transparent Blender renders onto exact white without touching opaque product pixels."""

from __future__ import annotations

import os
from pathlib import Path
import tempfile

from PIL import Image


def composite_rgba_over_white(path: Path | str) -> None:
    source = Path(path).expanduser().resolve()
    with Image.open(source) as opened:
        image = opened.convert("RGBA")
        white = Image.new("RGBA", image.size, (255, 255, 255, 255))
        result = Image.alpha_composite(white, image).convert("RGB")
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
