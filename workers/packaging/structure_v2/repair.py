"""Recrop carton print faces without running Blender or the full pipeline."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any, Callable, Mapping

from .artwork import ArtworkMappingError, render_face_assets

REQUIRED_PRINT_FACES = ("front", "back", "left", "right")
OPTIONAL_PRINT_FACES = ("top", "bottom")
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
RESOLVED_SCHEMA = "resolved-packaging-job/3"


def panel_png_valid(path: Path) -> bool:
    if not path.is_file():
        return False
    with path.open("rb") as handle:
        return handle.read(8) == PNG_MAGIC


def load_resolved(payload: Mapping[str, Any] | Path) -> dict[str, Any]:
    data: Any = payload
    if isinstance(payload, Path):
        data = json.loads(payload.read_text(encoding="utf-8"))
    if not isinstance(data, Mapping):
        raise ArtworkMappingError("structure_schema_unsupported", "结构结果不是对象")
    resolved = data.get("resolved") if data.get("schema") != RESOLVED_SCHEMA else data
    if not isinstance(resolved, Mapping) or resolved.get("schema") != RESOLVED_SCHEMA:
        raise ArtworkMappingError("structure_schema_unsupported", "不是受支持的 ResolvedPackagingJob")
    faces = resolved.get("faces")
    if not isinstance(faces, Mapping):
        raise ArtworkMappingError("structure_face_mapping_incomplete", "结构结果缺少面")
    missing = [face for face in REQUIRED_PRINT_FACES if not isinstance(faces.get(face), Mapping)]
    if missing:
        raise ArtworkMappingError("structure_face_mapping_incomplete", f"缺少 {','.join(missing)} 面")
    return dict(resolved)


def repair_print_faces(
    artwork: Path | str,
    resolved: Mapping[str, Any] | Path,
    assets_dir: Path | str,
    *,
    raster_width_px: int = 10_000,
    after_render: Callable[[Path], None] | None = None,
) -> dict[str, list[int]]:
    source = Path(artwork)
    destination = Path(assets_dir)
    mapping = load_resolved(resolved)
    tmp = destination / ".print-faces-tmp"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        sizes = render_face_assets(source, mapping, tmp, raster_width_px=raster_width_px)
        if after_render is not None:
            after_render(tmp)
        missing = [face for face in REQUIRED_PRINT_FACES if not panel_png_valid(tmp / f"panel_{face}.png")]
        if missing:
            raise ArtworkMappingError("structure_face_mapping_incomplete", f"刀线切面不完整，缺{missing}")
        destination.mkdir(parents=True, exist_ok=True)
        for face in (*REQUIRED_PRINT_FACES, *OPTIONAL_PRINT_FACES):
            src = tmp / f"panel_{face}.png"
            if not src.is_file():
                continue
            os.replace(src, destination / f"panel_{face}.png")
        return sizes
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
