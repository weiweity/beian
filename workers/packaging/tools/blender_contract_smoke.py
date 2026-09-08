#!/usr/bin/env python3
"""RF-11 Blender contract smoke.

Runs one synthetic carton through the existing quality evaluator. Output must
stay under RUNNER_TEMP. Does not read customer jobs, upload, or the product
queue. PowerShell only orchestrates timeout / drain; it does not reimplement
generation or GLB checks.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import uuid


EVAL_PATH = Path(__file__).resolve().parent / "render_quality_eval.py"
GENERATION_PATH = Path(__file__).resolve().parents[1] / "render_generation.py"


def load_eval():
    spec = importlib.util.spec_from_file_location("packaging_render_quality_eval_rf11", EVAL_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load evaluator: {EVAL_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_generation():
    spec = importlib.util.spec_from_file_location("packaging_render_generation_rf11", GENERATION_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load render_generation: {GENERATION_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def runner_temp() -> Path:
    raw = os.environ.get("RUNNER_TEMP")
    if not raw or not str(raw).strip():
        raise RuntimeError("runner_temp_missing")
    path = Path(raw).expanduser()
    if not path.is_dir():
        raise RuntimeError("runner_temp_not_directory")
    return path.resolve()


def verify_rendered_contract(eval_mod: object, report: dict) -> str | None:
    """Reuse render_generation GLB/hash gates. Do not seal product current."""
    gen = load_generation()
    output_dir = Path(str(report.get("output_dir") or ""))
    if (output_dir / ".render-generations").exists() or (output_dir / "generation.json").exists():
        return "generation_product_seal_forbidden"
    rendered = [item for item in (report.get("fixtures") or []) if item.get("rendered") is True]
    if not rendered:
        return "generation_outputs_missing"
    for item in rendered:
        fixture_dir = output_dir / str(item.get("fixture_id") or "")
        if (fixture_dir / "generation.json").exists() or (fixture_dir / ".render-generations").exists():
            return "generation_product_seal_forbidden"
        job_path = fixture_dir / "resolved_job.json"
        try:
            job = json.loads(job_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return "generation_contract_invalid"
        outputs = job.get("outputs") if isinstance(job.get("outputs"), dict) else {}
        assets = job.get("assets") if isinstance(job.get("assets"), dict) else {}
        glb_path = Path(str(outputs.get("glb") or ""))
        expected = ((item.get("outputs") or {}).get("glb") or {}).get("sha256") or {}
        expected_sha = expected.get("value") if isinstance(expected, dict) else None
        try:
            actual_sha = eval_mod.sha256_file(glb_path)  # type: ignore[attr-defined]
        except Exception:
            return "generation_hash_mismatch"
        if not expected_sha or actual_sha != expected_sha:
            return "generation_hash_mismatch"
        try:
            artifact = gen.load_glb_artifact(glb_path, max_bytes=gen.MAX_FILE_BYTES)
            glb_report = gen.compare_glb_artifact_contract(
                artifact,
                assets,
                job.get("dimensions_mm") or {},
                float(job.get("glb_tolerance_mm") or 0.5),
                (job.get("render") or {}).get("substrate_rgba"),
                geometry=((job.get("render_spec") or {}).get("geometry")),
                render_identity=job,
                material_layers=gen.material_runtime_from_job(job),
            )
        except Exception:
            return "runtime_glb_quality"
        if not isinstance(glb_report, dict) or glb_report.get("ok") is not True:
            return "runtime_glb_quality"
        for face in gen.SEMANTIC_FACES:
            path = Path(str(assets.get(face) or ""))
            reported = ((item.get("outputs") or {}).get(f"read_{face}") or {}).get("sha256") or {}
            value = reported.get("value") if isinstance(reported, dict) else None
            if value and eval_mod.sha256_file(path) != value:  # type: ignore[attr-defined]
                return "generation_hash_mismatch"
    return None


def assert_under_runner_temp(path: Path, root: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise RuntimeError("smoke output must stay under RUNNER_TEMP") from error
    return resolved


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="RF-11 synthetic Blender contract smoke")
    parser.add_argument("--blender", type=Path, help="Blender executable. Missing path fails closed.")
    args = parser.parse_args(argv)
    try:
        temp_root = runner_temp()
        eval_mod = load_eval()
        white = eval_mod.fixture_by_id(eval_mod.load_fixture_manifest(), "rf00-white-carton")
        output_dir = assert_under_runner_temp(
            temp_root / f"beian-blender-contract-smoke-{uuid.uuid4().hex}",
            temp_root,
        )
        blender = args.blender
        if blender is None:
            env_blender = os.environ.get("WB_BLENDER")
            blender = Path(env_blender) if env_blender else None
        report = eval_mod.run_eval(
            output_dir=output_dir,
            fixtures=[white],
            approved_baseline_path=output_dir.parent / f"{output_dir.name}-approved.json",
            update_baseline=False,
            render_blender=True,
            blender_executable=blender,
        )
    except Exception as error:
        public = str(error)
        if public in {"runner_temp_missing", "runner_temp_not_directory"}:
            print(json.dumps({"ok": False, "error": public, "production_ready": False, "human_acceptance": "pending"}, ensure_ascii=False))
            return 2
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": public if type(error).__name__ == "EvalError" else "blender_contract_smoke_failed",
                    "error_type": type(error).__name__,
                    "production_ready": False,
                    "human_acceptance": "pending",
                },
                ensure_ascii=False,
            )
        )
        return 2
    layers = report.get("quality_layers") if isinstance(report.get("quality_layers"), dict) else {}
    runtime = (layers.get("runtime_hard") or {}).get("status")
    generation_cause = None
    if runtime == "pass":
        generation_cause = verify_rendered_contract(eval_mod, report)
        if generation_cause:
            runtime = "fail"
            layers = dict(layers)
            hard = dict(layers.get("runtime_hard") or {})
            hard["status"] = "fail"
            hard["blocks_current"] = True
            reasons = list(hard.get("reasons") or [])
            reasons.append(generation_cause)
            hard["reasons"] = reasons
            layers["runtime_hard"] = hard
            metrics = dict(layers.get("machine_metrics") or {})
            metrics["runtime_integrity"] = "fail"
            layers["machine_metrics"] = metrics
    payload = {
        "ok": runtime == "pass" and generation_cause is None,
        "schema": "beian-blender-contract-smoke/1",
        "timeout_budget_s": 90,
        "timeout_budget_status": "candidate_not_hangzhou_frozen",
        "output_dir": report.get("output_dir"),
        "report": str(Path(report["output_dir"]) / "rf00-report.json") if report.get("output_dir") else None,
        "quality_layers": {
            "runtime_hard": runtime,
            "fixture_regression_hard": (layers.get("fixture_regression_hard") or {}).get("status"),
            "human_acceptance": layers.get("human_acceptance") or "pending",
            "production_ready": False,
        },
        "failure_reason": generation_cause or report.get("failure_reason"),
        "blender": report.get("blender"),
        "identity": {
            "input_sha256": report.get("input_sha256"),
            "render_profile_sha256": (report.get("identity") or {}).get("render_profile_sha256"),
        },
    }
    print(json.dumps(payload, ensure_ascii=False))
    if runtime != "pass" or generation_cause:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
