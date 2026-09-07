#!/usr/bin/env python3
"""RF-07 controlled view-transform experiment driver.

Fixes geometry, textures, materials, lights, exposure, look, resolution,
samples and seed. Only view_transform varies. Importing this module must not
create directories, call Blender, change the environment, or write results.
"""

from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
from typing import Any


PACKAGING_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGING_ROOT.parents[1]
DRIVER_PATH = Path(__file__).resolve()
WRAPPER_PATH = Path(__file__).resolve().parent / "render_quality_color_experiment_blender.py"
RFE02_DRIVER_PATH = Path(__file__).resolve().parent / "render_quality_experiment.py"
EVAL_PATH = Path(__file__).resolve().parent / "render_quality_eval.py"
RENDER_CONTRACT_PATH = PACKAGING_ROOT / "render_contract.py"
DECLARATION_PATH = (
    PACKAGING_ROOT / "fixtures" / "render-quality" / "experiments" / "rf07-color.json"
)
VERSION_PATH = REPO_ROOT / "VERSION"
ENV_JOB = "BEIAN_RF07_JOB"
TEMP_PREFIX = "beian-rf07-"
PLAN_SCHEMA = "beian-rf07-plan/1"
REPORT_SCHEMA = "beian-rf07-report/1"
DECLARATION_SCHEMA = "beian-rf07-color-experiment/1"
MAP_SCHEMA = "beian-rf07-candidate-map/1"
ENVELOPE_SCHEMA = "beian-rf07-job-envelope/1"
CONTACT_CELL = (360, 432)
SHEET_BG = (228, 228, 232, 255)
COLOR_CANDIDATES = ("Standard", "Khronos PBR Neutral", "AgX")
REQUIRED_STILLS = ("front_right", "back_left")
STUDIO_PROFILE_ID = "packshot-studio-explicit-v1"
NOT_ASSESSED = "not_assessed"
JOB_TIMEOUT_S = 300
ROUND_TIMEOUT_S = 1800


def wrapper_module() -> Any:
    spec = importlib.util.spec_from_file_location("packaging_rf07_wrapper", WRAPPER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load wrapper: {WRAPPER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rfe02_module() -> Any:
    spec = importlib.util.spec_from_file_location("packaging_rfe02_driver_rf07", RFE02_DRIVER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load RF-E02 driver: {RFE02_DRIVER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def eval_module() -> Any:
    spec = importlib.util.spec_from_file_location("packaging_render_quality_eval_rf07", EVAL_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load RF-00 evaluator: {EVAL_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def contract_module() -> Any:
    spec = importlib.util.spec_from_file_location("packaging_render_contract_rf07", RENDER_CONTRACT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load render contract: {RENDER_CONTRACT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_dumps(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def validate_declaration(payload: Mapping[str, Any]) -> dict[str, Any]:
    wrap = wrapper_module()
    if not isinstance(payload, Mapping) or payload.get("schema") != DECLARATION_SCHEMA:
        raise wrap.ExperimentError("invalid RF-07 experiment declaration")
    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        raise wrap.ExperimentError("declaration candidates missing")
    if len(candidates) != len(COLOR_CANDIDATES):
        raise wrap.ExperimentError("declaration candidates missing required transforms")
    if len(set(candidates)) != len(candidates):
        raise wrap.ExperimentError("declaration candidates duplicate")
    unsupported = [item for item in candidates if item not in COLOR_CANDIDATES]
    if unsupported:
        raise wrap.ExperimentError(f"declaration candidates unsupported: {unsupported}")
    if set(candidates) != set(COLOR_CANDIDATES):
        raise wrap.ExperimentError("declaration candidates missing required transforms")
    fixtures = payload.get("fixtures")
    required = ["rf00-white-carton", "rf00-dark-carton", "rf00-tall-carton", "rf00-wide-carton"]
    if list(fixtures) != required:
        raise wrap.ExperimentError("declaration fixtures must be white/dark/tall/wide")
    if payload.get("look") != "None" or float(payload.get("exposure") or 0) != 0.0:
        raise wrap.ExperimentError("look/exposure must stay contracted None/0")
    return dict(payload)


def load_declaration(path: Path | None = None) -> dict[str, Any]:
    target = Path(path or DECLARATION_PATH).resolve()
    payload = json.loads(target.read_text(encoding="utf-8"))
    return validate_declaration(payload)


def write_declaration_copy(root: Path, declaration: Mapping[str, Any]) -> tuple[Path, str]:
    dest = Path(root) / "declaration.json"
    dest.write_text(canonical_dumps(declaration) + "\n", encoding="utf-8")
    digest = sha256_file(dest)
    (Path(root) / "declaration.sha256").write_text(digest + "\n", encoding="utf-8")
    return dest, digest


def assert_preregistered_declaration(root: Path, declaration: Mapping[str, Any]) -> str:
    wrap = wrapper_module()
    dest = Path(root) / "declaration.json"
    recorded = (Path(root) / "declaration.sha256").read_text(encoding="utf-8").strip()
    actual = sha256_file(dest)
    expected = sha256_text(canonical_dumps(declaration) + "\n")
    if actual != recorded or actual != expected:
        raise wrap.ExperimentError("declaration hash mismatch")
    return actual


def collect_experiment_identity() -> dict[str, Any]:
    wrap = wrapper_module()
    return {
        "driver_sha256": sha256_file(DRIVER_PATH),
        "wrapper_sha256": sha256_file(WRAPPER_PATH),
        "declaration_sha256": sha256_file(DECLARATION_PATH),
        "render_job_sha256": sha256_file(PACKAGING_ROOT / "blender" / "render_job.py"),
        "render_contract_sha256": sha256_file(RENDER_CONTRACT_PATH),
        "studio_registry_sha256": sha256_file(
            PACKAGING_ROOT / "profiles" / "experiments" / "rf07-studio-color.v1.json"
        ),
        "rf06_registry_sha256": sha256_file(
            PACKAGING_ROOT / "profiles" / "experiments" / "rf06-materials.v1.json"
        ),
        "version": VERSION_PATH.read_text(encoding="utf-8").strip() if VERSION_PATH.is_file() else None,
        "product_default_semantics": "Standard",
        "source_identity": wrap.source_identity_payload(),
    }


def anonymous_candidate_map(declaration_sha256: str, candidates: Sequence[str]) -> dict[str, str]:
    ranked = sorted(
        candidates,
        key=lambda name: hashlib.sha256(f"{declaration_sha256}:{name}".encode("utf-8")).hexdigest(),
    )
    return {label: name for label, name in zip(("A", "B", "C"), ranked)}


def write_candidate_map(path: Path, mapping: Mapping[str, str], declaration_sha256: str) -> None:
    payload = {
        "schema": MAP_SCHEMA,
        "declaration_sha256": declaration_sha256,
        "labels": dict(mapping),
        "note": "mapping is stored separately from anonymous PNGs",
    }
    Path(path).write_text(canonical_dumps(payload) + "\n", encoding="utf-8")


def write_anonymous_contact_sheet(
    rows: Sequence[tuple[str, Sequence[tuple[str, Path]]]],
    dest: Path,
) -> dict[str, Any]:
    wrap = wrapper_module()
    from PIL import Image, ImageDraw

    if dest.exists():
        raise wrap.ExperimentError("contact sheet target must be new")
    cell_w, cell_h = CONTACT_CELL
    label_h = 28
    tile_w, tile_h = cell_w, cell_h + label_h
    columns = 3
    sheet = Image.new("RGBA", (tile_w * columns, tile_h * max(1, len(rows))), SHEET_BG)
    draw = ImageDraw.Draw(sheet)
    used = False
    for row_index, (fixture_id, cells) in enumerate(rows):
        for col, (label, path) in enumerate(cells):
            origin_x = col * tile_w
            origin_y = row_index * tile_h
            draw.rectangle((origin_x, origin_y, origin_x + tile_w, origin_y + tile_h), fill=SHEET_BG)
            caption = f"{fixture_id} {label}"
            draw.text((origin_x + 8, origin_y + 6), caption, fill=(20, 20, 20, 255))
            if path is None or not Path(path).is_file():
                continue
            with Image.open(path) as opened:
                image = opened.convert("RGBA")
                src_w, src_h = image.size
                scale = min(cell_w / float(src_w), cell_h / float(src_h), 1.0)
                fitted_w = max(1, int(round(src_w * scale)))
                fitted_h = max(1, int(round(src_h * scale)))
                if scale < 1.0:
                    image = image.resize((fitted_w, fitted_h), Image.Resampling.LANCZOS)
                paste_x = origin_x + (cell_w - fitted_w) // 2
                paste_y = origin_y + label_h + (cell_h - fitted_h) // 2
                sheet.alpha_composite(image, (paste_x, paste_y))
                used = True
    if not used:
        raise wrap.ExperimentError("no_readable_stills")
    handle, temp_name = tempfile.mkstemp(prefix=".rf07-contact.", suffix=".png", dir=str(dest.parent))
    os.close(handle)
    try:
        sheet.save(temp_name, format="PNG", compress_level=6)
        os.replace(temp_name, dest)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise
    return {"status": "measured", "value": str(dest), "method": "anonymous equal-cell contact sheet"}


def _object_without_paths(payload: Any) -> Any:
    if not isinstance(payload, Mapping):
        return payload
    copied = dict(payload)
    textures = []
    for item in copied.get("textures") or []:
        if not isinstance(item, Mapping):
            textures.append(item)
            continue
        textures.append(
            {key: value for key, value in item.items() if key not in {"path_name", "filepath"}}
        )
    copied["textures"] = textures
    return copied


def remaining_job_budget(round_deadline: float, now: float, job_timeout: float = JOB_TIMEOUT_S) -> float:
    remaining = float(round_deadline) - float(now)
    if remaining <= 0:
        return 0.0
    return min(float(job_timeout), remaining)


def _identity_payload(receipt: Mapping[str, Any]) -> dict[str, Any]:
    render = dict(receipt.get("render") or {})
    render.pop("view_transform", None)
    return {
        "lights": receipt.get("lights"),
        "world": receipt.get("world"),
        "camera": receipt.get("camera"),
        "object": _object_without_paths(receipt.get("object")),
        "engine": receipt.get("engine"),
        "render": render,
        "fixed_scene": receipt.get("fixed_scene"),
    }


def expected_suite_jobs(declaration: Mapping[str, Any], suite: str) -> list[dict[str, str]]:
    wrap = wrapper_module()
    fixtures = list(declaration["fixtures"])
    if suite == "smoke":
        fixtures = fixtures[:1]
    elif suite != "matrix":
        raise wrap.ExperimentError("suite must be smoke or matrix")
    return [
        {"fixture_id": fixture_id, "candidate": candidate}
        for fixture_id in fixtures
        for candidate in declaration["candidates"]
    ]


def fixed_scene_identity_ok(
    receipts: Sequence[Mapping[str, Any]],
    *,
    candidates: Sequence[str] = COLOR_CANDIDATES,
) -> bool:
    wrap = wrapper_module()
    if not isinstance(receipts, Sequence) or len(receipts) != len(candidates):
        return False
    transforms = []
    payloads = []
    for item in receipts:
        if wrap.rf07_pass_evidence_incomplete(item):
            return False
        render = item.get("render") or {}
        transform = render.get("view_transform") if isinstance(render, Mapping) else None
        value = transform.get("value") if isinstance(transform, Mapping) else None
        transforms.append(value)
        payloads.append(_identity_payload(item))
    if sorted(str(item) for item in transforms) != sorted(str(item) for item in candidates):
        return False
    if len(set(transforms)) != len(candidates):
        return False
    return all(item == payloads[0] for item in payloads[1:])


def select_color_winner(
    *,
    automatic: Mapping[str, Any] | None,
    human_approval: Mapping[str, Any] | None,
    p0_thresholds: Mapping[str, Any] | None,
) -> dict[str, Any]:
    return {
        "status": "awaiting_human_approval",
        "kept_view_transform": "Standard",
        "winner": None,
        "p0_thresholds": {
            "status": "not_assessed",
            "reason": "no_approved_p0_thresholds",
        },
        "private_artwork_blind_review": {
            "status": "not_assessed",
            "reason": "no_authorized_private_artwork_review",
        },
        "baseline_updated": False,
        "production_profile_frozen": False,
        "quality_improvement": NOT_ASSESSED,
        "automatic": automatic or {},
        "human_approval": human_approval,
        "p0_thresholds_input": p0_thresholds,
    }


def automatic_metrics_for_still(
    *,
    fixture_id: str,
    still_key: str,
    path: Path,
    eval_mod: Any,
) -> dict[str, Any]:
    metrics = eval_mod.collect_image_metrics(Path(path))
    type_fidelity = eval_mod.unavailable(
        "type_roi_not_projected_through_oblique_still",
        unit="1",
        method="RF-00 does not invert ORTHO stills back to face millimetres",
    )
    return {
        "fixture_id": fixture_id,
        "still_key": still_key,
        "white_separation": metrics.get("white_separation"),
        "alpha_border": metrics.get("alpha_border"),
        "pixel_size": metrics.get("pixel_size"),
        "sha256": metrics.get("sha256"),
        "delta_e": eval_mod.unavailable(
            "no_calibrated_color_roi_or_reference; whole-frame mean is not Delta E",
            method="RF-00 fixture has no measured colour ROI",
        ),
        "hairline_fidelity": type_fidelity,
        "dark_clipping": eval_mod.unavailable(
            "no_approved_dark_level_roi",
            method="do not substitute whole-image mean for dark clipping",
        ),
    }


def finalize_experiment_report(
    *,
    jobs: Sequence[Mapping[str, Any]],
    suite: str,
    root: Path,
    declaration: Mapping[str, Any] | None = None,
    human_approval: Mapping[str, Any] | None = None,
    identity_ok: Any = None,
    outputs_closed: Any = None,
) -> dict[str, Any]:
    wrap = wrapper_module()
    declaration = declaration or load_declaration()
    expected = expected_suite_jobs(declaration, suite)
    failures: list[str] = []
    # A positive flag cannot replace evidence; an explicit failure must veto it.
    if identity_ok is False:
        failures.append("source_identity_changed")
    if outputs_closed is False:
        failures.append("execution_or_anonymous_output_failed")
    job_list = list(jobs or [])
    if len(expected) == 0 or len(job_list) != len(expected):
        failures.append("job_count")
    seen = [(item.get("fixture_id"), item.get("candidate")) for item in job_list]
    if len(seen) != len(set(seen)):
        failures.append("duplicate_jobs")
    if sorted(seen) != sorted((item["fixture_id"], item["candidate"]) for item in expected):
        failures.append("job_set")
    if any(candidate not in declaration["candidates"] for _fixture, candidate in seen):
        failures.append("unknown_candidate")
    files_ok = True
    identity_groups: dict[str, list[dict[str, Any]]] = {}
    for job in job_list:
        if not isinstance(job, Mapping):
            files_ok = False
            continue
        if job.get("complete") is False or job.get("error"):
            files_ok = False
        outputs = job.get("outputs")
        hashes = job.get("output_hashes")
        passes = job.get("passes")
        if not isinstance(outputs, Mapping) or not isinstance(hashes, Mapping) or not isinstance(passes, list):
            files_ok = False
            continue
        job_candidate = job.get("candidate")
        for key in REQUIRED_STILLS:
            raw = outputs.get(key)
            path = Path(str(raw)) if raw else None
            if path is None or not path.is_file():
                files_ok = False
                continue
            try:
                resolved = path.resolve()
                resolved.relative_to(Path(root).resolve())
            except (OSError, ValueError):
                files_ok = False
                continue
            try:
                from PIL import Image

                with Image.open(resolved) as opened:
                    decoded = opened.convert("RGBA")
                    if decoded.size[0] < 1 or decoded.size[1] < 1:
                        files_ok = False
            except OSError:
                files_ok = False
            digest = sha256_file(path)
            if hashes.get(key) != digest:
                files_ok = False
            matching = [item for item in passes if isinstance(item, Mapping) and item.get("output_key") == key]
            if len(matching) != 1 or wrap.rf07_pass_evidence_incomplete(matching[0]):
                files_ok = False
                continue
            receipt = matching[0]
            transform = ((receipt.get("render") or {}).get("view_transform") or {})
            actual = transform.get("value") if isinstance(transform, Mapping) else None
            if actual != job_candidate or receipt.get("candidate") not in {None, job_candidate}:
                files_ok = False
            elif receipt.get("output_sha256") not in {digest, hashes.get(key)}:
                files_ok = False
        identity_groups.setdefault(str(job.get("fixture_id")), []).extend(
            item for item in passes if isinstance(item, Mapping) and item.get("output_key") in REQUIRED_STILLS
        )
    scene_ok = files_ok and not failures
    if scene_ok:
        expected_fixtures = {item["fixture_id"] for item in expected}
        if set(identity_groups) != expected_fixtures:
            scene_ok = False
        declared = tuple(declaration["candidates"])
        for recs in identity_groups.values():
            by_view = {key: [] for key in REQUIRED_STILLS}
            for item in recs:
                by_view.get(item.get("output_key"), []).append(item)
            for view_recs in by_view.values():
                if not fixed_scene_identity_ok(view_recs, candidates=declared):
                    scene_ok = False
    complete = bool(scene_ok and not failures and files_ok and len(job_list) == len(expected) and len(expected) > 0)
    decision = select_color_winner(automatic={}, human_approval=human_approval, p0_thresholds=None)
    return {
        "schema": REPORT_SCHEMA,
        "ok": complete,
        "complete": complete,
        "root": str(root),
        "jobs": job_list,
        "identity_ok": scene_ok,
        "outputs_closed": files_ok and complete,
        "failures": failures,
        "decision": decision,
        "quality_improvement": NOT_ASSESSED,
        "human_review": NOT_ASSESSED,
        "windows": NOT_ASSESSED,
        "l2": NOT_ASSESSED,
        "candidate_is_product_profile": False,
        "baseline_updated": False,
        "ignored_caller_flags": {
            "identity_ok": identity_ok,
            "outputs_closed": outputs_closed,
        },
    }


def _remove_empty_dir(path: Path) -> None:
    try:
        if path.is_dir() and next(path.iterdir(), None) is None:
            path.rmdir()
    except OSError:
        pass


def create_experiment_root(output: Path | None = None) -> Path:
    rfe02 = rfe02_module()
    if output is not None:
        root = Path(output)
        probe = root if root.exists() else root.parent
        rfe02.assert_experiment_root_allowed(probe)
        root.mkdir(parents=True, exist_ok=False)
        try:
            return rfe02.assert_experiment_root_allowed(root)
        except Exception:
            _remove_empty_dir(root)
            raise
    rfe02.assert_experiment_root_allowed(Path(tempfile.gettempdir()))
    raw = tempfile.mkdtemp(prefix=TEMP_PREFIX)
    root = Path(raw)
    try:
        return rfe02.assert_experiment_root_allowed(root)
    except Exception:
        _remove_empty_dir(root)
        raise


def _solid_assets(dest: Path, fill_rgb: Sequence[int]) -> dict[str, str]:
    from PIL import Image

    assets_dir = dest / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    color = (int(fill_rgb[0]), int(fill_rgb[1]), int(fill_rgb[2]), 255)
    assets = {}
    for face in ("front", "right", "back", "left", "top", "bottom"):
        path = assets_dir / f"panel_{face}.png"
        Image.new("RGBA", (512, 768), color).save(path)
        assets[face] = str(path)
    return assets


def _scene_receipts(record: Mapping[str, Any]) -> list[dict[str, Any]]:
    passes = record.get("passes") or []
    return [item for item in passes if isinstance(item, Mapping) and item.get("output_key") in REQUIRED_STILLS]


def run_experiment(
    *,
    suite: str = "matrix",
    render: bool = False,
    blender_executable: Path | None = None,
    output: Path | None = None,
) -> dict[str, Any]:
    wrap = wrapper_module()
    identity_before = collect_experiment_identity()
    declaration = load_declaration()
    jobs_plan = expected_suite_jobs(declaration, suite)
    fixtures = list(dict.fromkeys(item["fixture_id"] for item in jobs_plan))
    plan = {
        "schema": PLAN_SCHEMA,
        "ok": True,
        "suite": suite,
        "render": render,
        "jobs": jobs_plan,
        "job_count": len(jobs_plan),
        "candidate_is_product_profile": False,
        "quality_improvement": NOT_ASSESSED,
        "decision": select_color_winner(automatic={}, human_approval=None, p0_thresholds=None),
        "note": "dry-run emits plan JSON only; --render writes a private output root after declaration hash",
    }
    if not render:
        return {
            **plan,
            "identity": identity_before,
            "blender_subprocess_invoked": False,
            "wrote_files": False,
            "quality_improvement": NOT_ASSESSED,
            "human_review": NOT_ASSESSED,
            "windows": NOT_ASSESSED,
            "l2": NOT_ASSESSED,
            "kept_view_transform": "Standard",
        }

    eval_mod = eval_module()
    blender_path, blender_reason = rfe02_module().resolve_blender(blender_executable, eval_mod)
    if blender_path is None:
        return {
            "schema": REPORT_SCHEMA,
            "ok": False,
            "complete": False,
            "render": True,
            "suite": suite,
            "failure_reason": blender_reason or "blender_executable_missing",
            "blender_subprocess_invoked": False,
            "samples_written": False,
            "quality_improvement": NOT_ASSESSED,
            "decision": select_color_winner(automatic={}, human_approval=None, p0_thresholds=None),
            "identity": identity_before,
        }

    root = create_experiment_root(output)
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    declaration_path, declaration_sha = write_declaration_copy(root, declaration)
    assert_preregistered_declaration(root, declaration)
    (root / "plan.json").write_text(canonical_dumps(plan) + "\n", encoding="utf-8")
    mapping = anonymous_candidate_map(declaration_sha, declaration["candidates"])
    inverse = {name: label for label, name in mapping.items()}
    write_candidate_map(root / "candidate-map.json", mapping, declaration_sha)
    round_deadline = time.monotonic() + ROUND_TIMEOUT_S

    if str(PACKAGING_ROOT) not in sys.path:
        sys.path.insert(0, str(PACKAGING_ROOT))
    pipeline_mod = rfe02_module()._load_pipeline()
    contract = contract_module()
    manifest = eval_mod.load_fixture_manifest()
    jobs_out: list[dict[str, Any]] = []
    aborted = False
    failure_reason = None
    blender_invoked = False
    grouped: dict[str, dict[str, dict[str, Any]]] = {}
    try:
        for item in jobs_plan:
            if aborted:
                break
            fixture_id = item["fixture_id"]
            candidate = item["candidate"]
            label = inverse[candidate]
            spec = deepcopy(eval_mod.fixture_by_id(manifest, fixture_id))
            job_root = root / "jobs" / fixture_id / label
            job_root.mkdir(parents=True, exist_ok=False)
            dest = job_root / fixture_id
            eval_mod.materialize_fixture(spec, dest)
            assets = _solid_assets(job_root, spec["artwork"]["fill_rgb"])
            structure = {
                "schema": "resolved-packaging-job/3",
                "structure_schema": "packaging-structure/1",
                "structure_hash": "sha256:" + "a" * 64,
                "dimensions_mm": spec["dimensions_mm"],
                "faces": {face: {} for face in ("front", "right", "back", "left", "top", "bottom")},
                "validation": {"status": "accepted", "errors": [], "warnings": []},
            }
            plan_job = contract.render_plan_for_experimental_studio_job(structure, STUDIO_PROFILE_ID)
            outputs = {
                "glb": str(job_root / "model.glb"),
                "blend": str(job_root / "scene.blend"),
                "front_right": str(job_root / "front_right.png"),
                "back_left": str(job_root / "back_left.png"),
                "front_right_card": str(job_root / "front_right_card.png"),
                "back_left_card": str(job_root / "back_left_card.png"),
            }
            job = {
                **structure,
                "code": fixture_id,
                "display_name": "SYNTHETIC_NOT_CUSTOMER",
                "source_ai": "SYNTHETIC_NOT_CUSTOMER",
                "project_dir": str(job_root),
                "resolved_job_path": str(job_root / "resolved_job.json"),
                "assets": assets,
                "glb_tolerance_mm": 0.5,
                "render_spec": plan_job["spec"],
                "render": plan_job["render"],
                **plan_job["identity"],
                "outputs": outputs,
            }
            Path(job["resolved_job_path"]).write_text(canonical_dumps(job) + "\n", encoding="utf-8")
            envelope = {
                "schema": ENVELOPE_SCHEMA,
                "candidate": candidate,
                "look": "None",
                "exposure": 0.0,
                "fixture_id": fixture_id,
                "declaration_path": str(declaration_path),
                "declaration_sha256": declaration_sha,
                "anonymous_label": label,
                "candidate_is_product_profile": False,
            }
            envelope_path = job_root / "rf07-job-envelope.json"
            envelope_path.write_text(canonical_dumps(envelope) + "\n", encoding="utf-8")
            record: dict[str, Any] = {
                "fixture_id": fixture_id,
                "candidate": candidate,
                "anonymous_label": label,
                "project_dir": str(job_root),
            }
            try:
                budget = remaining_job_budget(round_deadline, time.monotonic())
                if budget <= 0:
                    raise wrap.ExperimentError("experiment_round_timeout")
                original_script = pipeline_mod.BLENDER_SCRIPT
                previous_env = os.environ.get(ENV_JOB)
                pipeline_mod.BLENDER_SCRIPT = WRAPPER_PATH
                os.environ[ENV_JOB] = str(envelope_path)
                try:
                    blender_invoked = True
                    pipeline_mod.run_blender_job(
                        job,
                        blender_path,
                        capture_deadline=time.monotonic() + budget,
                    )
                finally:
                    pipeline_mod.BLENDER_SCRIPT = original_script
                    if previous_env is None:
                        os.environ.pop(ENV_JOB, None)
                    else:
                        os.environ[ENV_JOB] = previous_env
                receipt = json.loads((job_root / wrap.JOB_RECEIPT_NAME).read_text(encoding="utf-8"))
                recorded = receipt.get("candidate")
                recorded_decl = receipt.get("declaration_sha256")
                if receipt.get("complete") is True and (
                    recorded != candidate or recorded_decl != declaration_sha
                ):
                    raise wrap.ExperimentError("receipt_identity_mismatch")
                if recorded not in {None, candidate}:
                    raise wrap.ExperimentError("receipt_candidate_mismatch")
                if recorded_decl not in {None, declaration_sha}:
                    raise wrap.ExperimentError("receipt_declaration_mismatch")
                for item in receipt.get("passes") or []:
                    if not isinstance(item, Mapping):
                        continue
                    if item.get("candidate") not in {None, candidate}:
                        raise wrap.ExperimentError("receipt_candidate_mismatch")
                    transform = ((item.get("render") or {}).get("view_transform") or {})
                    actual = transform.get("value") if isinstance(transform, Mapping) else None
                    if actual not in {None, candidate}:
                        raise wrap.ExperimentError("receipt_view_transform_mismatch")
                record["passes"] = receipt.get("passes") or []
                record["complete"] = receipt.get("complete") is True
                record["outputs"] = job.get("outputs")
                record["output_hashes"] = {
                    key: sha256_file(Path(path))
                    for key, path in outputs.items()
                    if Path(path).is_file()
                }
                anonymous_dir = root / "anonymous" / label / fixture_id
                anonymous_dir.mkdir(parents=True, exist_ok=True)
                for key in REQUIRED_STILLS:
                    source = Path(outputs[key])
                    if source.is_file():
                        shutil.copyfile(source, anonymous_dir / f"{key}.png")
                if record["complete"] is not True:
                    aborted = True
                    failure_reason = receipt.get("error") or "job_incomplete"
            except Exception as error:
                record["complete"] = False
                record["error_type"] = type(error).__name__
                record["error"] = str(error)[:240]
                aborted = True
                failure_reason = (
                    str(error) if isinstance(error, wrap.ExperimentError) else "blender_render_failed"
                )
            jobs_out.append(record)
            grouped.setdefault(fixture_id, {})[candidate] = record
            if aborted:
                break
    finally:
        identity_after = collect_experiment_identity()

    identity_ok = identity_after == identity_before
    scene_ok = True
    for fixture_id in fixtures:
        receipts = []
        for candidate in declaration["candidates"]:
            record = grouped.get(fixture_id, {}).get(candidate) or {}
            receipts.extend(_scene_receipts(record))
        if len(receipts) != len(declaration["candidates"]) * len(REQUIRED_STILLS):
            scene_ok = False
            continue
        by_view = {key: [] for key in REQUIRED_STILLS}
        for item in receipts:
            by_view[item["output_key"]].append(item)
        for view_receipts in by_view.values():
            if not fixed_scene_identity_ok(view_receipts):
                scene_ok = False
    if not identity_ok:
        aborted = True
        failure_reason = "identity_changed_during_run"
    if not scene_ok:
        aborted = True
        failure_reason = failure_reason or "fixed_scene_identity_changed"

    contact_rows = []
    for fixture_id in fixtures:
        cells = []
        for label in ("A", "B", "C"):
            path = root / "anonymous" / label / fixture_id / "front_right.png"
            cells.append((label, path if path.is_file() else None))
        contact_rows.append((fixture_id, cells))
    contact = None
    if not aborted:
        try:
            contact = write_anonymous_contact_sheet(contact_rows, root / "contact-sheet.png")
        except Exception as error:
            aborted = True
            failure_reason = failure_reason or str(error)[:240]

    automatic = []
    for record in jobs_out:
        outputs = record.get("outputs") or {}
        front = outputs.get("front_right")
        if front and Path(front).is_file():
            automatic.append(
                automatic_metrics_for_still(
                    fixture_id=record["fixture_id"],
                    still_key="front_right",
                    path=Path(front),
                    eval_mod=eval_mod,
                )
            )
    report = finalize_experiment_report(
        jobs=jobs_out,
        suite=suite,
        root=root,
        declaration=declaration,
        human_approval=None,
        identity_ok=identity_ok,
        outputs_closed=not aborted,
    )
    report.update(
        {
            "phase": "RF-07",
            "suite": suite,
            "render": True,
            "started_at": started,
            "ended_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "declaration_sha256": declaration_sha,
            "identity": identity_before,
            "identity_verified_after_run": identity_ok,
            "scene_identity_ok": scene_ok,
            "blender_subprocess_invoked": blender_invoked,
            "blender_path": str(blender_path),
            "contact_sheet": contact,
            "candidate_map": str(root / "candidate-map.json"),
            "anonymous_root": str(root / "anonymous"),
            "automatic_metrics": automatic,
            "failure_reason": None if report["complete"] else failure_reason,
            "product_behavior_changed": False,
            "wrote_rf00_baseline": False,
        }
    )
    if not identity_ok:
        report["identity_after"] = identity_after
    (root / "report.json").write_text(canonical_dumps(report) + "\n", encoding="utf-8")
    return report


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="RF-07 controlled view-transform experiment. Does not change product output."
    )
    parser.add_argument("--suite", choices=("smoke", "matrix"), default="matrix")
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--blender", type=Path)
    parser.add_argument("--output", type=Path, help="Isolated output directory outside any worktree.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    wrap = wrapper_module()
    args = parse_args(argv)
    try:
        report = run_experiment(
            suite=args.suite,
            render=args.render,
            blender_executable=args.blender,
            output=args.output,
        )
    except Exception as error:
        public = str(error) if isinstance(error, wrap.ExperimentError) else "rf07_experiment_failed"
        print(json.dumps({"ok": False, "error": public, "error_type": type(error).__name__}, ensure_ascii=False))
        return 1
    print(json.dumps(report, ensure_ascii=False))
    if report.get("ok") is True:
        return 0
    return 2 if report.get("failure_reason") in {"blender_executable_missing", "blender_executable_unusable"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
