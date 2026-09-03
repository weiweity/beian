from __future__ import annotations

from pathlib import Path
import json
import sys

import pytest

PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
if str(PACKAGING) not in sys.path:
    sys.path.insert(0, str(PACKAGING))

from structure_v2 import ArtworkMappingError, repair_print_faces  # noqa: E402
from test_packaging_structure_artwork import artwork_pdf, resolved_fixture  # noqa: E402

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def test_repair_writes_required_faces_via_tmp_then_replace(tmp_path: Path):
    assets = tmp_path / "assets"
    assets.mkdir()
    stale = assets / "panel_front.png"
    stale.write_bytes(b"OLD-NOT-PNG!!!!")
    source = artwork_pdf(tmp_path / "artwork.pdf")
    sizes = repair_print_faces(source, resolved_fixture(), assets, raster_width_px=1200)
    assert set(sizes) >= {"front", "back", "left", "right"}
    for face in ("front", "back", "left", "right"):
        panel = assets / f"panel_{face}.png"
        assert panel.is_file()
        assert panel.read_bytes()[:8] == PNG_MAGIC
    assert not (assets / ".print-faces-tmp").exists()


def test_mid_failure_leaves_existing_assets(tmp_path: Path):
    assets = tmp_path / "assets"
    assets.mkdir()
    existing = PNG_MAGIC + b"old-front"
    (assets / "panel_front.png").write_bytes(existing)
    (assets / "panel_back.png").write_bytes(PNG_MAGIC + b"old-back")
    source = artwork_pdf(tmp_path / "artwork.pdf")

    def boom(_tmp: Path) -> None:
        raise ArtworkMappingError("structure_face_mapping_incomplete", "boom")

    with pytest.raises(ArtworkMappingError, match="boom"):
        repair_print_faces(source, resolved_fixture(), assets, raster_width_px=1200, after_render=boom)

    assert (assets / "panel_front.png").read_bytes() == existing
    assert (assets / "panel_back.png").read_bytes() == PNG_MAGIC + b"old-back"
    assert not (assets / ".print-faces-tmp").exists()
    assert not (assets / "panel_left.png").exists()
    assert not (assets / "panel_right.png").exists()


def test_load_resolved_accepts_resolution_wrapper(tmp_path: Path):
    assets = tmp_path / "assets"
    source = artwork_pdf(tmp_path / "artwork.pdf")
    wrapper = tmp_path / "structure_resolution.json"
    wrapper.write_text(
        json.dumps({"status": "ready", "cache_hit": False, "resolved": resolved_fixture()}),
        encoding="utf-8",
    )
    sizes = repair_print_faces(source, wrapper, assets, raster_width_px=1200)
    assert "front" in sizes
    assert (assets / "panel_front.png").read_bytes()[:8] == PNG_MAGIC
