from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import pymupdf
import pytest


AUDIT = (
    Path(__file__).resolve().parents[4]
    / "workers"
    / "packaging"
    / "tools"
    / "audit_corpus.py"
)
THRESHOLDS = {
    "endpoint_snap_pt": 1.0,
    "paired_panel_relative_tolerance": 0.03,
    "outline_gap_pt": 1.0,
    "curve_linearization_error_pt": 0.5,
    "max_paths": 100_000,
    "max_path_points": 1_000_000,
    "max_structure_candidates": 8,
}


def audit_module():
    spec = importlib.util.spec_from_file_location("packaging_corpus_audit", AUDIT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def synthetic_ai(path: Path) -> Path:
    document = pymupdf.open()
    page = document.new_page(width=240, height=180)
    knife = document.add_ocg("刀线")
    printing = document.add_ocg("印刷")
    for x in (40, 80, 120, 160, 200):
        page.draw_line(
            pymupdf.Point(x, 40),
            pymupdf.Point(x, 140),
            color=(1, 0, 0),
            width=0.5,
            oc=knife,
        )
    for y in (40, 140):
        page.draw_line(
            pymupdf.Point(25, y),
            pymupdf.Point(215, y),
            color=(1, 0, 0),
            width=0.5,
            oc=knife,
        )
    page.draw_rect(
        pymupdf.Rect(80, 50, 120, 130),
        color=None,
        fill=(0.45, 0.1, 0.15),
        oc=printing,
    )
    document.save(path)
    document.close()
    return path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def truth_for(source: Path, *, status: str = "approved") -> dict:
    sample: dict = {
        "filename": source.name,
        "sha256": digest(source),
        "truth_status": status,
    }
    if status == "approved":
        sample["expected_geometry"] = {
            "family": "rectangular_carton",
            "family_id": "synthetic-rectangular-carton-v1",
            "dimensions_mm": {"width": 40, "depth": 40, "height": 100},
            "face_mapping_status": "approved",
            "faces": {name: {"source_panel": name, "rotation_deg": 0} for name in audit_module().FACE_NAMES},
        }
        sample["golden_sample"] = True
        sample["approved_by"] = "test-reviewer"
    return {"schema_version": 1, "thresholds": THRESHOLDS, "samples": [sample]}


def test_audit_corpus_is_read_only_and_writes_evidence(tmp_path: Path):
    audit = audit_module()
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    source = synthetic_ai(corpus / "box.ai")
    before_hash = digest(source)
    before_mtime = source.stat().st_mtime_ns
    truth_path = tmp_path / "truth.json"
    truth_path.write_text(
        json.dumps(truth_for(source), ensure_ascii=False),
        encoding="utf-8",
    )

    manifest, errors = audit.audit_corpus(
        corpus,
        truth_path,
        tmp_path / "evidence",
        include_baseline=False,
    )

    assert errors == []
    assert manifest["phase0_exit"]["status"] == "pass"
    assert manifest["summary"]["sample_count"] == 1
    assert manifest["summary"]["rectangular_carton_candidate_count"] == 1
    assert manifest["summary"]["truth_family_cluster_count"] == 1
    assert manifest["summary"]["golden_sample_count"] == 1
    record = manifest["samples"][0]
    assert record["sha256"] == before_hash
    assert record["pdf_compatible"] is True
    assert record["page_points"] == [240.0, 180.0]
    assert record["ocg_layers"] == ["刀线", "印刷"]
    assert record["vector"]["drawing_count"] >= 8
    assert record["vector"]["structure_candidate_paths"] >= 7
    assert record["truth"]["truth_status"] == "approved"
    assert record["baseline_parser"]["reason"] == "disabled"
    assert digest(source) == before_hash
    assert source.stat().st_mtime_ns == before_mtime
    assert (tmp_path / "evidence" / "corpus_manifest.json").is_file()
    report = (tmp_path / "evidence" / "corpus_report.md").read_text(encoding="utf-8")
    assert "Phase 0 Exit Gate" in report
    assert "PASS" in report


def test_audit_reports_pending_truth_without_changing_production(tmp_path: Path):
    audit = audit_module()
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    source = synthetic_ai(corpus / "pending.ai")
    truth_path = tmp_path / "truth.json"
    truth_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "thresholds": {},
                "samples": [
                    {
                        "filename": source.name,
                        "sha256": digest(source),
                        "truth_status": "pending_manual",
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    manifest, errors = audit.audit_corpus(
        corpus,
        truth_path,
        tmp_path / "evidence",
        include_baseline=False,
    )

    assert manifest["phase0_exit"]["status"] == "blocked"
    assert any("阈值未冻结" in error for error in errors)
    assert any("真值未批准" in error for error in errors)
    assert manifest["samples"][0]["truth"]["truth_status"] == "pending_manual"


def test_audit_rejects_output_inside_real_corpus(tmp_path: Path):
    audit = audit_module()
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    synthetic_ai(corpus / "box.ai")

    with pytest.raises(audit.AuditError, match="输出目录不能位于真实稿语料目录内"):
        audit.audit_corpus(
            corpus,
            None,
            corpus / "evidence",
            include_baseline=False,
        )


def test_truth_rejects_approved_sample_without_dimensions(tmp_path: Path):
    audit = audit_module()
    path = tmp_path / "truth.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "thresholds": THRESHOLDS,
                "samples": [
                    {
                        "filename": "broken.ai",
                        "truth_status": "approved",
                        "approved_by": "test-reviewer",
                        "expected_geometry": {
                            "family": "rectangular_carton",
                            "family_id": "broken-family",
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(audit.AuditError, match="dimensions_mm"):
        audit.load_truth(path)


def test_truth_rejects_invalid_threshold_value(tmp_path: Path):
    audit = audit_module()
    path = tmp_path / "truth.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "thresholds": {**THRESHOLDS, "endpoint_snap_pt": 0},
                "samples": [],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(audit.AuditError, match="endpoint_snap_pt"):
        audit.load_truth(path)


def test_truth_rejects_approved_sample_without_complete_faces(tmp_path: Path):
    audit = audit_module()
    source = synthetic_ai(tmp_path / "box.ai")
    payload = truth_for(source)
    del payload["samples"][0]["expected_geometry"]["faces"]["bottom"]
    path = tmp_path / "truth.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(audit.AuditError, match="完整六面映射"):
        audit.load_truth(path)
