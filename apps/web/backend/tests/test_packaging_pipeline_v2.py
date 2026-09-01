from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image
import pymupdf
import pytest

from packaging_structure_fixture import semantic_box


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"


def pipeline_module():
    spec = importlib.util.spec_from_file_location("packaging_pipeline_v2", PACKAGING / "pipeline.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_artwork(path: Path) -> Path:
    mm_to_pt = 72.0 / 25.4
    document = pymupdf.open()
    page = document.new_page(width=120 * mm_to_pt, height=90 * mm_to_pt)
    faces = {
        "back": ((0, 20, 30, 70), (28, 96, 120)),
        "left": ((30, 20, 50, 70), (51, 113, 82)),
        "front": ((50, 20, 80, 70), (117, 35, 46)),
        "right": ((80, 20, 100, 70), (191, 145, 64)),
        "top": ((50, 70, 80, 90), (100, 69, 127)),
        "bottom": ((50, 0, 80, 20), (55, 111, 145)),
    }
    for rect, rgb in faces.values():
        page.draw_rect(
            pymupdf.Rect(*(value * mm_to_pt for value in rect)),
            color=None,
            fill=tuple(value / 255 for value in rgb),
        )
    # Asymmetric corner marks make a rotated or mirrored face fail even when
    # its center color still looks correct.
    for rect, _rgb in faces.values():
        x0, y0, x1, y1 = rect
        page.draw_rect(
            pymupdf.Rect(*((value * mm_to_pt) for value in (x0 + 1, y0 + 1, x0 + 5, y0 + 5))),
            color=None,
            fill=(1, 1, 1),
        )
        page.draw_rect(
            pymupdf.Rect(*((value * mm_to_pt) for value in (x1 - 5, y1 - 5, x1 - 1, y1 - 1))),
            color=None,
            fill=(0, 0, 0),
        )
    document.save(path)
    document.close()
    return path


def prepare_v2_product(tmp_path: Path) -> tuple[dict, Path]:
    source = tmp_path / "source.ai"
    source.write_bytes(b"private-ai-fixture")
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    sidecar = tmp_path / "source.ai.structure.json"
    sidecar.write_text(json.dumps(semantic_box(source_hash=source_hash)), encoding="utf-8")
    artwork = write_artwork(tmp_path / "artwork.pdf")
    template = tmp_path / "render-profile.json"
    template.write_text(
        json.dumps(
            {
                "template_id": "v2-test-render-profile",
                "raster_width_px": 1200,
                "render": {
                    "resolution_x": 800,
                    "resolution_y": 900,
                    "camera_ortho_scale_mm": 80,
                    "front_rotation_deg": 0,
                    "back_rotation_deg": 180,
                },
                "glb_tolerance_mm": 0.5,
            }
        ),
        encoding="utf-8",
    )
    return (
        {
            "code": "V2BOX",
            "slug": "semantic",
            "display_name": "语义结构测试盒",
            "source_ai": source.name,
            "template": template.name,
            "structure_engine": "v2",
            "structure_sidecar": sidecar.name,
            "artwork_pdf": artwork.name,
        },
        source,
    )


def test_pipeline_v2_uses_resolved_geometry_and_exact_artwork(tmp_path: Path):
    pipeline = pipeline_module()
    product, _source = prepare_v2_product(tmp_path)
    output = tmp_path / "output"
    job = pipeline.preflight_product(
        product,
        tmp_path,
        output,
        False,
        {"enabled": False},
        False,
    )
    assert job["structure_engine"] == "v2"
    assert job["dimensions_mm"] == {"width": 30.0, "depth": 20.0, "height": 50.0}
    assert job["input_mode"] == "semantic_sidecar"
    assert job["illustrator_invoked"] is False
    assert all(Path(path).is_file() for path in job["assets"].values())
    assert job["face_texture_sizes"]["front"] == [600, 1_000]
    assert job["face_texture_sizes"]["right"] == [400, 1_000]
    expected_centers = {
        "front": (117, 35, 46),
        "right": (191, 145, 64),
        "back": (28, 96, 120),
        "left": (51, 113, 82),
        "top": (100, 69, 127),
        "bottom": (55, 111, 145),
    }
    for face, rgb in expected_centers.items():
        with Image.open(job["assets"][face]).convert("RGB") as image:
            center = image.getpixel((image.width // 2, image.height // 2))
            width_mm = 20 if face in {"left", "right"} else 30
            height_mm = 20 if face in {"top", "bottom"} else 50
            top_left = image.getpixel(
                (round(image.width * 3 / width_mm), round(image.height * 3 / height_mm))
            )
            bottom_right = image.getpixel(
                (
                    round(image.width * (width_mm - 3) / width_mm),
                    round(image.height * (height_mm - 3) / height_mm),
                )
            )
        assert center == pytest.approx(rgb, abs=2), face
        assert top_left == pytest.approx((255, 255, 255), abs=5), face
        assert bottom_right == pytest.approx((0, 0, 0), abs=5), face
    resolution = json.loads(Path(job["structure_resolution_path"]).read_text(encoding="utf-8"))
    assert resolution["status"] == "ready"

    for path in job["outputs"].values():
        Path(path).write_bytes(b"cached-output")
    pipeline.save_json(Path(job["project_dir"]) / "pipeline_result.json", job)
    cached = pipeline.preflight_product(
        product,
        tmp_path,
        output,
        False,
        {"enabled": False},
        False,
    )
    assert cached["cache_hit"] is True


def test_pipeline_v2_never_falls_back_to_layer_name_guessing(tmp_path: Path):
    pipeline = pipeline_module()
    product, source = prepare_v2_product(tmp_path)
    product.pop("structure_sidecar")
    source.with_name(source.name + ".structure.json").unlink()
    with pytest.raises(pipeline.PipelineHold) as raised:
        pipeline.preflight_product(
            product,
            tmp_path,
            tmp_path / "output",
            False,
            {"enabled": False},
            False,
        )
    assert raised.value.code == "structure_semantics_missing"
    assert raised.value.status == "review_required"


def test_illustrator_structure_export_accepts_a_windows_executable_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    pipeline = pipeline_module()
    source = tmp_path / "source.ai"
    source.write_bytes(b"ai")
    illustrator = tmp_path / "Illustrator.exe"
    illustrator.write_bytes(b"exe")

    captured: dict[str, object] = {}

    def fake_run(command, capture_output, text):
        config_path = Path(command[2])
        config = json.loads(config_path.read_text(encoding="utf-8"))
        captured.update(config)
        for key in ("full_pdf", "print_pdf", "structure_json"):
            Path(config[key]).write_bytes(b"output")
        Path(config["result_json"]).write_text(
            json.dumps(
                {
                    "success": True,
                    "full_pdf": config["full_pdf"],
                    "print_pdf": config["print_pdf"],
                    "structure_json": config["structure_json"],
                }
            ),
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(command, 0, "ok", "")

    monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
    result = pipeline.run_illustrator_structure_export(
        source,
        tmp_path / "project",
        {"application": str(illustrator)},
        proposal_layers=["供应商结构候选"],
        print_layers=["印刷"],
    )
    assert result["success"] is True
    assert captured["proposal_layers"] == ["供应商结构候选"]
    assert captured["print_layers"] == ["印刷"]


def test_legacy_illustrator_fallback_accepts_a_windows_executable_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    pipeline = pipeline_module()
    source = tmp_path / "source.ai"
    source.write_bytes(b"not-pdf-compatible")
    template = tmp_path / "template.json"
    template.write_text("{}", encoding="utf-8")
    illustrator = tmp_path / "Illustrator.exe"
    illustrator.write_bytes(b"exe")

    class ReachedWorker(RuntimeError):
        pass

    def reached_worker(*_args, **_kwargs):
        raise ReachedWorker("legacy Windows worker reached")

    monkeypatch.setattr(pipeline.sys, "platform", "win32")
    monkeypatch.setattr(pipeline, "run_illustrator_fallback", reached_worker)
    with pytest.raises(ReachedWorker, match="worker reached"):
        pipeline.preflight_product(
            {
                "code": "LEGACY",
                "slug": "windows",
                "display_name": "Windows legacy fallback",
                "source_ai": source.name,
                "template": template.name,
            },
            tmp_path,
            tmp_path / "output",
            False,
            {"enabled": True, "application": str(illustrator)},
            False,
        )


def test_windows_illustrator_bridge_changes_invalidate_pipeline_cache(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    pipeline = pipeline_module()
    source = tmp_path / "source.ai"
    template = tmp_path / "template.json"
    runner = tmp_path / "run_export.vbs"
    source.write_bytes(b"ai")
    template.write_text("{}", encoding="utf-8")
    runner.write_text("bridge-v1", encoding="utf-8")
    monkeypatch.setattr(pipeline, "ILLUSTRATOR_WINDOWS_RUNNER", runner)

    first = pipeline.job_fingerprint(source, template, {"structure_engine": "v2"})
    runner.write_text("bridge-v2", encoding="utf-8")
    second = pipeline.job_fingerprint(source, template, {"structure_engine": "v2"})

    assert first != second


def test_preflight_cli_writes_a_prepared_manifest_without_starting_blender(tmp_path: Path):
    product, _source = prepare_v2_product(tmp_path)
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "output_root": str(tmp_path / "output"),
                "blender_executable": str(tmp_path / "missing-blender"),
                "illustrator": {"enabled": False},
                "generate_ppt": False,
                "products": [product],
            }
        ),
        encoding="utf-8",
    )
    process = subprocess.run(
        [sys.executable, str(PACKAGING / "pipeline.py"), str(manifest), "--preflight-only"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    report = json.loads(process.stdout.strip().splitlines()[-1])
    assert report["mode"] == "preflight"
    prepared_path = Path(report["prepared_manifest"])
    assert prepared_path.is_file()
    prepared = json.loads(prepared_path.read_text(encoding="utf-8"))
    assert prepared["products"][0]["structure_engine"] == "v2"
    assert Path(prepared["products"][0]["structure_sidecar"]).is_file()
    assert Path(prepared["products"][0]["artwork_pdf"]).is_file()
    assert "STAGE structure" in process.stderr


def test_preflight_cli_returns_recoverable_structure_control_json(tmp_path: Path):
    product, source = prepare_v2_product(tmp_path)
    product.pop("structure_sidecar")
    source.with_name(source.name + ".structure.json").unlink()
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "output_root": str(tmp_path / "output"),
                "illustrator": {"enabled": False},
                "products": [product],
            }
        ),
        encoding="utf-8",
    )
    process = subprocess.run(
        [sys.executable, str(PACKAGING / "pipeline.py"), str(manifest), "--preflight-only"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 3
    control = json.loads(process.stderr.strip().splitlines()[-1])
    assert control["kind"] == "structure_resolution"
    assert control["structure_status"] == "review_required"
    assert control["code"] == "structure_semantics_missing"
    assert Path(control["resolution_path"]).is_file()
    assert Path(control["details"]["artwork_preview"]).is_file()
