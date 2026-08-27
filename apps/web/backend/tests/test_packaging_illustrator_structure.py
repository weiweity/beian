from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
WORKER = PACKAGING / "illustrator" / "illustrator_worker.py"
EXPORTER = PACKAGING / "illustrator" / "export_structure.jsx"
WINDOWS_RUNNER = PACKAGING / "illustrator" / "run_export.vbs"


def load_worker():
    spec = importlib.util.spec_from_file_location("packaging_illustrator_worker_v2", WORKER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_structure_export_is_opt_in_and_legacy_worker_is_unchanged():
    worker = load_worker()
    assert worker.select_jsx({}).name == "export_ai.jsx"
    assert worker.select_jsx({"structure_json": "structure.json"}).name == "export_structure.jsx"


def test_structure_export_hides_objects_not_whole_layers():
    source = EXPORTER.read_text(encoding="utf-8")
    assert "item.hidden = true" in source
    assert "documentRef.layers[layerIndex].visible =" not in source
    assert 'adapter: "illustrator-semantic/1"' in source
    assert 'structure_face_mapping_incomplete' in source


def test_explicit_ignore_objects_are_removed_from_artwork_without_becoming_edges():
    source = EXPORTER.read_text(encoding="utf-8")
    semantic_push = source.index("semanticItems.push(record.item)")
    ignore_guard = source.index('if (record.assignment === "ignore")')
    edge_export = source.index("exportSemanticPath(", ignore_guard)
    assert semantic_push < ignore_guard < edge_export


def test_semantics_require_exact_tags_or_explicit_config():
    source = EXPORTER.read_text(encoding="utf-8")
    assert 'var prefix = "packaging:"' in source
    assert 'configuredAssignment(config, "layers"' in source
    assert 'configuredAssignment(config, "spots"' in source
    assert "刀线" not in source
    assert "刀版" not in source


def test_legacy_proposal_layers_only_offer_stroke_only_paths_for_human_confirmation():
    source = EXPORTER.read_text(encoding="utf-8")
    assert "configuredProposalLayer(item, config)" in source
    assert "item.stroked && !item.filled" in source
    assert 'adapter = "illustrator-stroke-proposal/1"' in source
    assert '"structure_proposal_requires_confirmation"' in source
    assert "explicitRecords.length > 0 ? explicitRecords : proposalRecords" in source


def test_proposal_paths_are_cleaned_from_artwork_without_hiding_the_whole_layer():
    source = EXPORTER.read_text(encoding="utf-8")
    assert "chosenRecords" in source
    assert "semanticItems.push(record.item)" in source
    assert "documentRef.layers[layerIndex].visible =" not in source


def test_windows_bridge_runs_the_same_bound_jsx_exporter(tmp_path: Path):
    worker = load_worker()
    exporter = tmp_path / "worker.jsx"
    exporter.write_text("jsonStringify(result);\n", encoding="utf-8")
    config = tmp_path / r"C:\supply\data\jobs\O'Brien\结构.json"
    runtime = worker.materialize_runtime_jsx(exporter, config)
    source = runtime.read_text(encoding="utf-8")
    assert source.startswith(
        "var PIPELINE_CONFIG_PATH = " + json.dumps(str(config), ensure_ascii=True) + ";\n"
    )
    assert source.endswith("jsonStringify(result);\n")

    command = worker.windows_runner_command(
        "run",
        runtime,
        cscript=Path(r"C:\Windows\System32\cscript.exe"),
    )
    assert command == [
        r"C:\Windows\System32\cscript.exe",
        "//Nologo",
        str(WINDOWS_RUNNER),
        "run",
        str(runtime),
    ]


def test_windows_bridge_uses_official_com_jsx_entrypoint_and_guards_open_docs():
    source = WINDOWS_RUNNER.read_text(encoding="utf-8")
    assert 'CreateObject("Illustrator.Application")' in source
    assert "DoJavaScriptFile" in source
    assert "appRef.Documents.Count <> 0" in source
    assert "Shell.Application" not in source


def test_windows_probe_contract_rejects_malformed_output():
    worker = load_worker()
    assert worker.parse_windows_probe("30.0\t0") == ("30.0", 0)
    try:
        worker.parse_windows_probe("not-a-contract")
    except ValueError as error:
        assert "invalid response" in str(error)
    else:
        raise AssertionError("malformed Windows probe must fail closed")


def test_windows_warmup_refuses_to_touch_an_open_illustrator_document(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    worker = load_worker()
    application = tmp_path / "Illustrator.exe"
    application.write_bytes(b"exe")
    monkeypatch.setattr(worker.subprocess, "Popen", lambda *args, **kwargs: object())
    monkeypatch.setattr(
        worker.subprocess,
        "run",
        lambda *args, **kwargs: worker.subprocess.CompletedProcess(
            args[0], 0, "30.0\t1", ""
        ),
    )
    with pytest.raises(RuntimeError, match="no other open documents"):
        worker.warm_up_windows_illustrator(application, 30)
