from __future__ import annotations

import importlib.util
import zipfile
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


def test_thick_line_clamps_huge_endpoints():
    d = dieline()
    mask = bytearray(8 * 8)
    d._thick_line(mask, 8, 8, -(10**12), 3, 10**12, 3)
    assert sum(mask) > 0
    assert sum(mask) <= 8 * 8


def test_knife_drawings_safe_rejects_print_flats():
    d = dieline()
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=200, height=200)
        page.draw_rect(pymupdf.Rect(0, 0, 200, 200), fill=(0.2, 0.2, 0.2), color=None)
        assert d.knife_drawings_safe(page) is False
        page2 = doc.new_page(width=200, height=200)
        page2.draw_line(pymupdf.Point(10, 10), pymupdf.Point(80, 10))
        page2.draw_line(pymupdf.Point(80, 10), pymupdf.Point(80, 90))
        assert d.knife_drawings_safe(page2) is True
        page3 = doc.new_page(width=200, height=200)
        assert d.knife_drawings_safe(page3) is False
    finally:
        doc.close()


def test_vector_fallback_when_raster_oversplits(tmp_path: Path):
    d = dieline()
    from PIL import Image

    doc = pymupdf.open()
    page = doc.new_page(width=500, height=360)
    xs = [50, 160, 250, 360, 450]
    y0, y1 = 50, 280
    for x in xs:
        page.draw_line(pymupdf.Point(x, y0), pymupdf.Point(x, y1), color=(0, 0, 0), width=0.05)
    page.draw_line(pymupdf.Point(xs[0], y0), pymupdf.Point(xs[-1], y0), color=(0, 0, 0), width=0.05)
    page.draw_line(pymupdf.Point(xs[0], y1), pymupdf.Point(xs[-1], y1), color=(0, 0, 0), width=0.05)
    noise = Image.new("RGB", (420, 260), (255, 255, 255))
    pix = noise.load()
    step = 3
    for y in range(0, 260, step):
        for x in range(0, 420, step):
            pix[x, y] = (0, 0, 0)
    noise_path = tmp_path / "noise.png"
    noise.save(noise_path)
    page.insert_image(pymupdf.Rect(40, 40, 460, 310), filename=str(noise_path))
    pdf = tmp_path / "synth-knife.pdf"
    doc.save(str(pdf))
    doc.close()
    layout = d.parse_knife_pdf(pdf, "刀线")
    dims = layout["dimensions_mm"]
    assert layout["die_source"] == "vector"
    assert layout["family"] in {"carton", "flat"}
    assert {"front", "back", "left", "right"} <= {p["role"] for p in layout["panels"]}
    assert 18 <= dims["width"] <= 80
    assert 18 <= dims["depth"] <= 80
    assert 40 <= dims["height"] <= 160


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
    blank = tmp_path / "blank.pdf"
    doc = pymupdf.open()
    doc.new_page(width=200, height=200)
    doc.save(str(blank))
    doc.close()
    with pytest.raises(RuntimeError, match="找不到展开图"):
        d.parse_knife_pdf(blank, "刀线")


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
    assert layout["die_source"] == "raster"
    assert layout["family"] in {"carton", "flat"}
    assert 40 < dims["width"] < 55
    assert 40 < dims["depth"] < 55
    assert 150 < dims["height"] < 175
    template = d.layout_to_template(layout)
    assert template["source"] == "dieline"
    assert template["family"] in {"carton", "flat"}
    assert "front" in template["face_boxes"]


def _draw_square_carton(page, x0: float) -> None:
    x = x0
    page.draw_rect(pymupdf.Rect(x, 160, x + 40, 620), color=(0, 0, 0), width=1.2)
    x += 40
    for _ in range(4):
        page.draw_rect(pymupdf.Rect(x, 160, x + 120, 620), color=(0, 0, 0), width=1.2)
        x += 120


def test_parse_two_up_cartons_are_not_pouch(tmp_path: Path):
    d = dieline()
    doc = pymupdf.open()
    page = doc.new_page(width=1800, height=720)
    _draw_square_carton(page, 80)
    _draw_square_carton(page, 980)
    pdf = _save(tmp_path / "two_up.pdf", doc)
    layout = d.parse_knife_pdf(pdf, "刀线")
    assert layout["family"] in {"carton", "flat"}
    assert layout["dimensions_mm"]["depth"] != 3.0
    assert 40 < layout["dimensions_mm"]["width"] < 55


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
def test_real_26f23_collagen_stick_folds(tmp_path: Path):
    d = dieline()
    p = pipeline()
    src = SAMPLES / "转曲-C-译龄紧颜抗皱胶原棒-花盒-26F23A.ai"
    assert src.is_file()
    knife_pdf = tmp_path / "26f23.pdf"
    p.make_layer_pdf(src, knife_pdf, {"刀线"})
    layout = d.parse_knife_pdf(knife_pdf, "刀线")
    dims = layout["dimensions_mm"]
    assert layout["family"] in {"carton", "flat"}
    assert {"front", "back", "left", "right"} <= {p["role"] for p in layout["panels"]}
    assert 18 <= dims["width"] <= 80
    assert 18 <= dims["depth"] <= 80
    assert 40 <= dims["height"] <= 160


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


def test_resolve_node_bin_windows_program_files(monkeypatch, tmp_path: Path):
    p = pipeline()
    fake = tmp_path / "node.exe"
    fake.write_text("")
    monkeypatch.delenv("RUNTIME_NODE", raising=False)
    monkeypatch.setattr(p.shutil, "which", lambda name: None)
    monkeypatch.setattr(p, "WINDOWS_NODE_CANDIDATES", (fake,))
    assert p.resolve_node_bin() == fake.resolve()


def test_write_white_pptx_without_node(tmp_path: Path, monkeypatch):
    p = pipeline()
    from PIL import Image

    monkeypatch.delenv("PATH", raising=False)
    monkeypatch.delenv("RUNTIME_NODE", raising=False)
    monkeypatch.delenv("RUNTIME_NODE_MODULES", raising=False)
    front = tmp_path / "front.png"
    back = tmp_path / "back.png"
    Image.new("RGB", (24, 16), (255, 0, 0)).save(front)
    Image.new("RGB", (24, 16), (0, 0, 255)).save(back)
    dest = tmp_path / "pack_white.pptx"
    out = p.write_white_pptx(front, back, dest, title="胶原棒")
    assert out == dest
    assert dest.is_file()
    with zipfile.ZipFile(dest) as zf:
        names = set(zf.namelist())
        assert "[Content_Types].xml" in names
        assert "ppt/media/image1.png" in names
        assert "ppt/media/image2.png" in names
        assert zf.read("ppt/media/image1.png") == front.read_bytes()
        assert zf.read("ppt/media/image2.png") == back.read_bytes()
        assert b"front-right-render" in zf.read("ppt/slides/slide1.xml")
        assert b"back-left-render" in zf.read("ppt/slides/slide1.xml")


def test_write_white_pptx_failure_paths(tmp_path: Path):
    p = pipeline()
    from PIL import Image

    dest = tmp_path / "pack.pptx"
    missing = tmp_path / "nope.png"
    junk = tmp_path / "junk.png"
    junk.write_bytes(b"not-a-png-file")
    ok = tmp_path / "ok.png"
    Image.new("RGB", (8, 8), (255, 255, 255)).save(ok)
    with pytest.raises(p.PipelineError, match="缺白底图"):
        p.write_white_pptx(missing, ok, dest)
    with pytest.raises(p.PipelineError, match="不是 PNG"):
        p.write_white_pptx(junk, ok, dest)
    with pytest.raises(p.PipelineError, match="缺白底图"):
        p.write_white_pptx_for_job({"project_dir": str(tmp_path), "outputs": {}})


def test_write_white_pptx_for_job_escapes_title(tmp_path: Path):
    p = pipeline()
    from PIL import Image

    front = tmp_path / "front.png"
    back = tmp_path / "back.png"
    Image.new("RGB", (12, 8), (255, 0, 0)).save(front)
    Image.new("RGB", (12, 8), (0, 0, 255)).save(back)
    dest = tmp_path / "pack.pptx"
    p.write_white_pptx(front, back, dest, title='A&B <x> "q"')
    with zipfile.ZipFile(dest) as zf:
        xml = zf.read("ppt/slides/slide1.xml").decode("utf-8")
        assert "A&amp;B &lt;x&gt; &quot;q&quot;" in xml
        assert "<x>" not in xml
    job = {
        "code": "26F23A",
        "slug": "stick",
        "display_name": "胶原棒",
        "project_dir": str(tmp_path),
        "outputs": {"front_right": str(front), "back_left": str(back)},
    }
    p.write_white_pptx_for_job(job)
    pptx = Path(job["outputs"]["pptx"])
    assert pptx.is_file()
    assert "3D包装展示" in pptx.name


def test_write_sheet_pdf_skips_without_front(tmp_path: Path):
    p = pipeline()
    from PIL import Image

    job = {"code": "X", "project_dir": str(tmp_path), "outputs": {}}
    p.write_sheet_pdf(job)
    assert "sheet_pdf" not in job["outputs"]
    assert not (tmp_path / "X_white_sheet.pdf").exists()
    front = tmp_path / "front.png"
    Image.new("RGB", (16, 12), (255, 255, 255)).save(front)
    only_front = {
        "code": "Y",
        "project_dir": str(tmp_path),
        "outputs": {"front_right": str(front)},
    }
    p.write_sheet_pdf(only_front)
    dest = Path(only_front["outputs"]["sheet_pdf"])
    assert dest.is_file()
    assert dest.name == "Y_white_sheet.pdf"


def test_write_sheet_pdf_without_node(tmp_path: Path):
    p = pipeline()
    from PIL import Image

    front = tmp_path / "front.png"
    back = tmp_path / "back.png"
    Image.new("RGB", (40, 30), (255, 255, 255)).save(front)
    Image.new("RGB", (40, 30), (240, 240, 240)).save(back)
    job = {
        "code": "26F23A",
        "display_name": "胶原棒",
        "project_dir": str(tmp_path),
        "outputs": {"front_right": str(front), "back_left": str(back)},
    }
    p.write_sheet_pdf(job)
    dest = Path(job["outputs"]["sheet_pdf"])
    assert dest.is_file()
    assert dest.name == "26F23A_white_sheet.pdf"
    doc = pymupdf.open(dest)
    try:
        assert doc.page_count == 1
        pix = doc[0].get_pixmap()
        n = pix.n
        i = (2 * pix.width + 2) * n
        assert pix.samples[i] >= 250 and pix.samples[i + 1] >= 250 and pix.samples[i + 2] >= 250
    finally:
        doc.close()


def test_write_sheet_pdf_pillow_when_pymupdf_raises(tmp_path: Path, monkeypatch):
    p = pipeline()
    from PIL import Image

    front = tmp_path / "front.png"
    back = tmp_path / "back.png"
    Image.new("RGB", (40, 30), (255, 255, 255)).save(front)
    Image.new("RGB", (40, 30), (255, 255, 255)).save(back)
    job = {
        "code": "PILL",
        "display_name": "胶原棒",
        "project_dir": str(tmp_path),
        "outputs": {"front_right": str(front), "back_left": str(back)},
    }
    monkeypatch.setattr(pymupdf, "open", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no mupdf")))
    p.write_sheet_pdf(job)
    dest = Path(job["outputs"]["sheet_pdf"])
    assert dest.is_file()
    assert dest.read_bytes()[:4] == b"%PDF"


def test_fit_white_rgb_flattens_alpha_onto_white(tmp_path: Path):
    p = pipeline()
    from PIL import Image

    src = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    src.putpixel((3, 3), (220, 30, 40, 255))
    path = tmp_path / "rgba.png"
    src.save(path)
    out = p._fit_white_rgb(path, 20, 16)
    assert out.mode == "RGB"
    assert out.size == (20, 16)
    assert out.getpixel((0, 0)) == (255, 255, 255)
    x = (20 - 8) // 2 + 3
    y = (16 - 8) // 2 + 3
    assert out.getpixel((x, y)) == (220, 30, 40)


def test_write_sheet_pdf_pillow_page_is_white(tmp_path: Path):
    p = pipeline()
    from PIL import Image

    front = tmp_path / "front.png"
    back = tmp_path / "back.png"
    Image.new("RGB", (40, 30), (255, 255, 255)).save(front)
    Image.new("RGB", (40, 30), (255, 255, 255)).save(back)
    dest = tmp_path / "sheet.pdf"
    p._write_sheet_pdf_pillow(dest, str(front), str(back))
    assert dest.is_file()
    doc = pymupdf.open(dest)
    try:
        pix = doc[0].get_pixmap()
        n = pix.n
        i = (2 * pix.width + 2) * n
        assert pix.samples[i] >= 250 and pix.samples[i + 1] >= 250 and pix.samples[i + 2] >= 250
    finally:
        doc.close()


def test_resolve_node_bin_uses_which(monkeypatch, tmp_path: Path):
    p = pipeline()
    fake = tmp_path / "node.exe"
    fake.write_text("")
    monkeypatch.delenv("RUNTIME_NODE", raising=False)
    monkeypatch.setattr(
        p.shutil,
        "which",
        lambda name: str(fake) if name in ("node", "node.exe") else None,
    )
    assert p.resolve_node_bin() == fake.resolve()


def test_presentation_runtime_none_without_node(monkeypatch):
    p = pipeline()
    monkeypatch.delenv("RUNTIME_NODE", raising=False)
    monkeypatch.setattr(p.shutil, "which", lambda name: None)
    assert p.resolve_node_bin() is None
    assert p.presentation_runtime() is None


def test_presentation_runtime_none_without_ppt_modules(monkeypatch, tmp_path: Path):
    p = pipeline()
    fake = tmp_path / "node"
    fake.write_text("")
    monkeypatch.delenv("RUNTIME_NODE_MODULES", raising=False)
    monkeypatch.delenv("RUNTIME_BIN_DIR", raising=False)
    monkeypatch.setattr(p, "DEFAULT_NODE_MODULES", p.Path(""))
    monkeypatch.setattr(p, "DEFAULT_RUNTIME_BIN", p.Path(""))
    monkeypatch.setattr(p.shutil, "which", lambda name: str(fake) if name in ("node", "node.exe") else None)
    monkeypatch.setattr(p, "ROOT", tmp_path / "packaging")
    (tmp_path / "packaging" / "ppt").mkdir(parents=True)
    assert p.resolve_node_bin() == fake.resolve()
    assert p.presentation_runtime() is None
    assert p._env_dir("RUNTIME_NODE_MODULES", p.Path("")) is None


def test_all_output_files_exist_without_ppt(tmp_path: Path):
    p = pipeline()
    files = {}
    for key in ("blend", "glb", "front_right", "back_left"):
        f = tmp_path / key
        f.write_text("x")
        files[key] = str(f)
    assert p.all_output_files_exist({"outputs": files}, False) is True
    assert p.all_output_files_exist({"outputs": files}, True) is True
