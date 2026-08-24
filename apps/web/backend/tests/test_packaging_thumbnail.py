from __future__ import annotations

import importlib.util
from pathlib import Path

import pymupdf
from PIL import Image

PIPE = Path(__file__).resolve().parents[4] / "workers" / "packaging" / "pipeline.py"


def _load():
    spec = importlib.util.spec_from_file_location("packaging_pipeline", PIPE)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_pipeline_emits_named_stages():
    text = PIPE.read_text(encoding="utf-8")
    assert 'emit_stage("render_pdf")' in text
    assert 'emit_stage("blender")' in text
    assert 'emit_stage("export")' in text


def test_render_pdf_thumbnail_tiny_page_fails(tmp_path):
    pdf = tmp_path / "tiny.pdf"
    doc = pymupdf.open()
    doc.new_page(width=0.5, height=100)
    doc.save(str(pdf))
    doc.close()
    pipe = _load()
    try:
        pipe.render_pdf_thumbnail(pdf, tmp_path / "thumbs", 400)
        raise AssertionError("expected PipelineError")
    except pipe.PipelineError as err:
        assert "页宽" in str(err)


def test_render_pdf_thumbnail_ignores_thin_cropbox(tmp_path):
    pdf = tmp_path / "crop.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=200, height=100)
    page.set_cropbox(pymupdf.Rect(0, 0, 1.1, 100))
    page.insert_text((20, 50), "hi")
    doc.save(str(pdf))
    doc.close()
    pipe = _load()
    out = pipe.render_pdf_thumbnail(pdf, tmp_path / "thumbs", 400)
    with Image.open(out) as im:
        assert im.size[0] == 400
        assert im.size[1] == 200


def test_render_pdf_thumbnail_caps_pixel_budget(tmp_path):
    pdf = tmp_path / "tall.pdf"
    doc = pymupdf.open()
    doc.new_page(width=80, height=4000)
    doc.save(str(pdf))
    doc.close()
    pipe = _load()
    out = pipe.render_pdf_thumbnail(pdf, tmp_path / "thumbs", 8000)
    with Image.open(out) as im:
        assert im.size[0] * im.size[1] <= pipe.MAX_RASTER_PIXELS + 16


def test_render_pdf_thumbnail_uses_pymupdf(tmp_path):
    pdf = tmp_path / "face.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=200, height=100)
    page.insert_text((20, 50), "hi")
    doc.save(str(pdf))
    doc.close()

    pipe = _load()
    out = pipe.render_pdf_thumbnail(pdf, tmp_path / "thumbs", 400)
    assert out.is_file()
    with Image.open(out) as im:
        assert im.size[0] == 400
        assert im.size[1] == 200
