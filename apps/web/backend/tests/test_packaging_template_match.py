from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

PIPE = Path(__file__).resolve().parents[4] / "workers" / "packaging" / "pipeline.py"


def _load():
    spec = importlib.util.spec_from_file_location("packaging_pipeline", PIPE)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _write(path: Path, expected: list[float], template_id: str, description: str) -> None:
    path.write_text(
        json.dumps(
            {
                "template_id": template_id,
                "description": description,
                "expected_page_points": expected,
                "page_size_tolerance_ratio": 0.02,
                "dimensions_mm": {"width": 10, "depth": 10, "height": 20},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def test_pick_template_keeps_assigned_when_page_matches(tmp_path: Path):
    pipe = _load()
    assigned = tmp_path / "square.json"
    _write(assigned, [2833.5, 1507.67], "square", "方形花盒")
    picked, data = pipe.pick_template(assigned, [2833.5, 1507.67], tmp_path / "art.ai")
    assert picked == assigned
    assert data["template_id"] == "square"


def test_pick_template_switches_to_matching_sibling(tmp_path: Path):
    pipe = _load()
    assigned = tmp_path / "square.json"
    other = tmp_path / "sachet.json"
    _write(assigned, [2833.5, 1507.67], "square", "方形花盒")
    _write(other, [1498.67, 1446.0], "sachet", "5片装")
    picked, data = pipe.pick_template(assigned, [1498.67, 1446.0], tmp_path / "art.ai")
    assert picked == other
    assert data["template_id"] == "sachet"


def test_pick_template_skips_smoke_even_if_size_matches(tmp_path: Path):
    pipe = _load()
    assigned = tmp_path / "square.json"
    smoke = tmp_path / "flower_box_illustrator_smoke.json"
    _write(assigned, [2833.5, 1507.67], "square", "方形花盒")
    _write(smoke, [1498.67, 1446.0], "smoke", "不要用")
    with pytest.raises(pipe.PipelineError) as err:
        pipe.pick_template(assigned, [1498.67, 1446.0], tmp_path / "art.ai")
    text = str(err.value)
    assert "画板尺寸与模板不符" in text
    assert "方形花盒" in text
    assert "不要用" not in text


def test_pick_template_mismatch_does_not_stretch(tmp_path: Path):
    pipe = _load()
    assigned = tmp_path / "square.json"
    _write(assigned, [2833.5, 1507.67], "square", "方形花盒")
    with pytest.raises(pipe.PipelineError) as err:
        pipe.pick_template(assigned, [1498.67, 1446.0], tmp_path / "five.ai")
    text = str(err.value)
    assert "已登记=[10×10×20mm 方形花盒]" in text
    assert "five.ai" in text
