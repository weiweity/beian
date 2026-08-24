from __future__ import annotations

import importlib.util
from pathlib import Path

import pymupdf
import pytest

PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
SAMPLES = Path(__file__).resolve().parents[4] / "测试" / "打烊台" / "2D平面图"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def dieline():
    return _load("packaging_dieline", PACKAGING / "dieline.py")


def pipeline():
    return _load("packaging_pipeline", PACKAGING / "pipeline.py")


def test_pick_knife_layer_aliases():
    d = dieline()
    assert d.pick_knife_layer(["印刷", "刀线", "标注"]) == "刀线"
    assert d.pick_knife_layer(["表格", "刀版"]) == "刀版"
    assert d.pick_knife_layer(["印刷", "标注"]) is None
    assert d.pick_knife_layer(["无刀线说明", "印刷"]) is None


def test_layout_sane_rejects_tiny_noise():
    d = dieline()
    four = [{"role": n} for n in ("front", "back", "left", "right")]
    assert d.layout_sane({"family": "carton", "dimensions_mm": {"width": 47, "depth": 47, "height": 170}, "panels": four})
    assert not d.layout_sane({"family": "flat", "dimensions_mm": {"width": 14, "depth": 25, "height": 31}})
    assert not d.layout_sane(
        {
            "family": "carton",
            "dimensions_mm": {"width": 47, "depth": 47, "height": 170},
            "panels": [{"role": "front"}, {"role": "left"}, {"role": "right"}],
        }
    )
    assert d.layout_sane(
        {"family": "pouch", "dimensions_mm": {"width": 140, "depth": 3, "height": 200}, "panels": [{"role": "front"}, {"role": "back"}]}
    )
    assert not d.layout_sane(
        {"family": "carton", "dimensions_mm": {"width": 900, "depth": 47, "height": 170}, "panels": four}
    )
    assert not d.layout_sane(
        {"family": "pouch", "dimensions_mm": {"width": 140, "depth": 3, "height": 900}, "panels": [{"role": "front"}, {"role": "back"}]}
    )
    assert not d.layout_sane(
        {"family": "carton", "dimensions_mm": {"width": float("inf"), "depth": 47, "height": 170}, "panels": four}
    )


def test_dieline_error_paths(tmp_path: Path):
    d = dieline()
    with pytest.raises(RuntimeError, match="找不到展开图"):
        d.pick_main_regions([], 3, 1.0)
    with pytest.raises(RuntimeError, match="竖线太少"):
        d.assign_body_panels([0.0, 10.0, 20.0])
    with pytest.raises(RuntimeError, match="面宽太碎"):
        d.assign_body_panels([0, 1, 2, 3, 4])
    from pypdf import PdfWriter

    empty = tmp_path / "empty.pdf"
    writer = PdfWriter()
    with empty.open("wb") as stream:
        writer.write(stream)
    with pytest.raises(RuntimeError, match="没有页"):
        d.parse_knife_pdf(empty, "刀线")


def test_parse_knife_pdf_ignores_thin_cropbox(tmp_path: Path):
    d = dieline()
    doc = pymupdf.open()
    page = doc.new_page(width=900, height=720)
    x = 80
    page.draw_rect(pymupdf.Rect(x, 160, x + 40, 620), color=(0, 0, 0), width=1.2)
    x += 40
    for _ in range(4):
        page.draw_rect(pymupdf.Rect(x, 160, x + 120, 620), color=(0, 0, 0), width=1.2)
        x += 120
    page.set_cropbox(pymupdf.Rect(0, 0, 1.1, 720))
    pdf = _save(tmp_path / "crop.pdf", doc)
    layout = d.parse_knife_pdf(pdf, "刀线")
    dims = layout["dimensions_mm"]
    assert 40 < dims["width"] < 55
    assert 150 < dims["height"] < 175


def test_assign_body_panels_square_and_flat():
    d = dieline()
    family, spans = d.assign_body_panels([0, 42, 177, 312, 447, 582])
    assert family == "carton"
    assert len(spans) == 4
    family, spans = d.assign_body_panels([0, 58, 468, 533, 943, 985])
    assert family == "flat"
    assert len(spans) == 4
    assert spans[1][1] - spans[1][0] > spans[0][1] - spans[0][0]


def _save(path: Path, doc: pymupdf.Document) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(path))
    doc.close()
    return path


def test_parse_synthetic_carton(tmp_path: Path):
    d = dieline()
    doc = pymupdf.open()
    page = doc.new_page(width=900, height=720)
    page.draw_rect(pymupdf.Rect(40, 20, 520, 90), color=(0, 0, 0), width=1)
    x = 80
    page.draw_rect(pymupdf.Rect(x, 160, x + 40, 620), color=(0, 0, 0), width=1.2)
    x += 40
    for _ in range(4):
        page.draw_rect(pymupdf.Rect(x, 160, x + 120, 620), color=(0, 0, 0), width=1.2)
        x += 120
    pdf = _save(tmp_path / "carton.pdf", doc)
    layout = d.parse_knife_pdf(pdf, "刀线")
    dims = layout["dimensions_mm"]
    assert layout["family"] in {"carton", "flat"}
    assert 40 < dims["width"] < 55
    assert 40 < dims["depth"] < 55
    assert 150 < dims["height"] < 175
    template = d.layout_to_template(layout)
    assert template["source"] == "dieline"
    assert template["family"] in {"carton", "flat"}
    assert "front" in template["face_boxes"]


def test_parse_synthetic_pouch(tmp_path: Path):
    d = dieline()
    doc = pymupdf.open()
    page = doc.new_page(width=1000, height=700)
    page.draw_rect(pymupdf.Rect(80, 60, 380, 620), color=(0.1, 0.1, 0.1), width=2)
    page.draw_rect(pymupdf.Rect(520, 60, 820, 620), color=(0.1, 0.1, 0.1), width=2)
    pdf = _save(tmp_path / "pouch.pdf", doc)
    layout = d.parse_knife_pdf(pdf, "刀线")
    assert layout["family"] == "pouch"
    assert len(layout["panels"]) == 2
    assert 95 < layout["dimensions_mm"]["width"] < 120
    assert 185 < layout["dimensions_mm"]["height"] < 210
    assert layout["dimensions_mm"]["depth"] == 3.0


@pytest.mark.skipif(not SAMPLES.is_dir(), reason="本地打样样张不在 CI")
def test_real_26h17_recovers_square_flower_box(tmp_path: Path):
    d = dieline()
    p = pipeline()
    src = SAMPLES / "转曲 D-达肤妍男士精华水花盒—26H17A.ai"
    assert src.is_file()
    knife_pdf = tmp_path / "26h17.pdf"
    p.make_layer_pdf(src, knife_pdf, {"刀线"})
    layout = d.parse_knife_pdf(knife_pdf, "刀线")
    dims = layout["dimensions_mm"]
    assert layout["family"] == "carton"
    assert abs(dims["width"] - 47.5) < 4
    assert abs(dims["depth"] - 47.5) < 4
    assert abs(dims["height"] - 177.5) < 8


@pytest.mark.skipif(not SAMPLES.is_dir(), reason="本地打样样张不在 CI")
def test_real_5pack_is_flat_carton(tmp_path: Path):
    d = dieline()
    p = pipeline()
    src = SAMPLES / "转曲D-达肤妍祛痘细肤面膜-5片装花盒-26H06A.ai"
    knife_pdf = tmp_path / "5pack.pdf"
    p.make_layer_pdf(src, knife_pdf, {"刀线"})
    layout = d.parse_knife_pdf(knife_pdf, "刀线")
    dims = layout["dimensions_mm"]
    assert layout["family"] == "flat"
    assert abs(dims["width"] - 145) < 12
    assert abs(dims["depth"] - 22) < 8
    assert dims["height"] > 180


@pytest.mark.skipif(not SAMPLES.is_dir(), reason="本地打样样张不在 CI")
def test_real_30ml_is_pouch(tmp_path: Path):
    d = dieline()
    p = pipeline()
    src = SAMPLES / "转曲D-达肤妍祛痘细肤面膜30ml稿件-26H11A.ai"
    knife_pdf = tmp_path / "pouch.pdf"
    p.make_layer_pdf(src, knife_pdf, {"刀线"})
    layout = d.parse_knife_pdf(knife_pdf, "刀线")
    dims = layout["dimensions_mm"]
    assert layout["family"] == "pouch"
    assert abs(dims["width"] - 139) < 12
    assert abs(dims["height"] - 200) < 12
    assert dims["depth"] == 3.0
