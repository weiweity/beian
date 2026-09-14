"""Resolve R04 matrix commands to argv. Never executes product or native apps."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import scenarios

PLACEHOLDER_RE = re.compile(r"\{[A-Za-z0-9_]+\}")
STALE_WORKTREE = "worktrees/beian-r04-resource-stress"
PROBE_DIR_REL = "scripts/resource-stress/probes"

HISTORICAL_DISPOSITION = {
    "face_probe.py": {
        "action": "adopted",
        "in_repo": f"{PROBE_DIR_REL}/face_probe.py",
        "note": "argv repo/out/case; expected reject may exit 0",
    },
    "render_probe.py": {
        "action": "adopted",
        "in_repo": f"{PROBE_DIR_REL}/render_probe.py",
        "note": "Blender path required; no /Applications default",
    },
    "upload-probe.mjs": {
        "action": "adopted",
        "in_repo": f"{PROBE_DIR_REL}/upload-probe.mjs",
        "note": "simulated in-process Hono; 100MiB is historical size, not run here",
    },
    "queue-probe.mjs": {
        "action": "adopted",
        "in_repo": f"{PROBE_DIR_REL}/queue-probe.mjs",
        "note": "durable queue + synthetic worker; not Blender duration",
    },
    "budget-probe.mjs": {
        "action": "adopted",
        "in_repo": f"{PROBE_DIR_REL}/budget-probe.mjs",
        "note": "32MiB is probe input, not product 4096MiB/8192MiB defaults",
    },
    "measure.py": {
        "action": "replaced_by_existing",
        "in_repo": None,
        "note": "covered by protocol.py measure_command and cli.py; do not copy a second sampler",
    },
    "write_report.py": {
        "action": "replaced_by_existing",
        "in_repo": None,
        "note": "covered by protocol.render_report_md, evidence.summarize_rounds, and cli persist",
    },
}

TSX_CANDIDATES = (
    "apps/web/server/node_modules/tsx/dist/esm/index.mjs",
    "node_modules/tsx/dist/esm/index.mjs",
    "apps/web/server/node_modules/tsx/esm.mjs",
)

NODE_SCENES = {"dual-upload", "queue-drain", "fail-cancel"}
NPM_SCENES = {"illustrator-busy", "relight"}
BLENDER_SCENES = {"blender-serial"}
PYTHON_SCENES = {
    "normal",
    "tall",
    "wide",
    "near-cap",
    "exact-cap-paper",
    "over-cap",
    "failure-after-front",
    "blender-serial",
}


def leftover_placeholders(tokens: list[str]) -> list[str]:
    found: list[str] = []
    for token in tokens:
        found.extend(PLACEHOLDER_RE.findall(token))
    return found


def interpolate(tokens: list[str], mapping: dict[str, str]) -> list[str]:
    filled: list[str] = []
    for token in tokens:
        current = token
        for key, value in mapping.items():
            current = current.replace("{" + key + "}", value)
        leftover = PLACEHOLDER_RE.findall(current)
        if leftover:
            raise ValueError("unresolved:" + ",".join(leftover))
        filled.append(current)
    return filled


def interpreter_has_module(python: Path, name: str) -> bool:
    """Ask the selected interpreter whether a module exists without importing the product."""
    try:
        completed = subprocess.run(
            [
                str(python),
                "-c",
                "import importlib.util,sys; raise SystemExit(0 if importlib.util.find_spec(sys.argv[1]) else 1)",
                name,
            ],
            capture_output=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


def find_tsx(repo: Path, explicit: Path | None = None) -> Path | None:
    if explicit is not None:
        return explicit if explicit.is_file() else None
    for rel in TSX_CANDIDATES:
        candidate = repo / rel
        if candidate.is_file():
            return candidate
    return None


def resolve_executable(name: str, explicit: str | None) -> Path | None:
    if explicit:
        path = Path(explicit)
        return path if path.is_file() else None
    found = shutil.which(name)
    return Path(found) if found else None


def bindings(
    *,
    repo: Path,
    out: Path,
    python: str | Path,
    node: str | Path | None = None,
    npm: str | Path | None = None,
    tsx: str | Path | None = None,
    blender: str | Path | None = None,
) -> dict[str, Any]:
    repo_r = Path(repo).resolve()
    out_r = Path(out)
    if not out_r.is_absolute():
        out_r = out_r.resolve()
    reasons: list[str] = []
    if STALE_WORKTREE in str(repo_r):
        reasons.append("stale_worktree_path")
    if not repo_r.is_dir():
        reasons.append("repo_not_directory")
    python_path = Path(python)
    if not python_path.is_file():
        reasons.append("python_not_file")
    node_path = resolve_executable("node", str(node) if node else None)
    npm_path = resolve_executable("npm", str(npm) if npm else None)
    tsx_path = find_tsx(repo_r, Path(tsx) if tsx else None)
    blender_raw = str(blender).strip() if blender else ""
    blender_path = Path(blender_raw) if blender_raw else None
    if blender_path is not None and not blender_path.is_file():
        reasons.append("blender_not_file")
        blender_path = None
    probe_dir = repo_r / PROBE_DIR_REL
    python_modules = {}
    if python_path.is_file():
        python_modules["pymupdf"] = interpreter_has_module(python_path, "pymupdf")
    return {
        "repo": repo_r,
        "out": out_r,
        "python": python_path,
        "node": node_path,
        "npm": npm_path,
        "tsx": tsx_path,
        "blender": blender_path,
        "probe_dir": probe_dir,
        "python_modules": python_modules,
        "binding_reasons": reasons,
    }


def _mapping(bound: dict[str, Any], scene_id: str) -> dict[str, str]:
    mapping = {
        "repo": str(bound["repo"]),
        "out": str(bound["out"]),
        "name": scene_id,
        "python": str(bound["python"]),
        "probe": str(bound["probe_dir"]),
    }
    if bound["node"] is not None:
        mapping["node"] = str(bound["node"])
    if bound["npm"] is not None:
        mapping["npm"] = str(bound["npm"])
    if bound["tsx"] is not None:
        mapping["tsx"] = str(bound["tsx"])
    if bound["blender"] is not None:
        mapping["blender"] = str(bound["blender"])
    return mapping


def resolve_scene(scene_id: str, bound: dict[str, Any]) -> dict[str, Any]:
    contract = scenarios.SCENARIO_CONTRACT.get(scene_id)
    scene = next((row for row in scenarios.SCENARIOS if row["id"] == scene_id), None)
    if contract is None or scene is None:
        return {
            "id": scene_id,
            "ok": False,
            "argv": None,
            "status": "refused",
            "reasons": ["unknown_scene"],
            "runnable": False,
            "simulated": False,
            "budget_eligibility": None,
            "this_slice_execute": False,
        }
    reasons = list(bound.get("binding_reasons") or [])
    probe_name = contract.get("probe")
    if probe_name:
        probe_path = bound["probe_dir"] / probe_name
        if not probe_path.is_file():
            reasons.append("missing_probe")
    if scene_id in PYTHON_SCENES and not Path(bound["python"]).is_file():
        reasons.append("missing_python")
    if scene_id in PYTHON_SCENES and bound.get("python_modules", {}).get("pymupdf") is not True:
        reasons.append("missing_pymupdf")
    if scene_id in NODE_SCENES:
        if bound["node"] is None:
            reasons.append("missing_node")
        if bound["tsx"] is None:
            reasons.append("missing_tsx")
    if scene_id in NPM_SCENES and bound["npm"] is None:
        reasons.append("missing_npm")
    if scene_id in BLENDER_SCENES and bound["blender"] is None:
        reasons.append("blender_not_specified")
    argv = None
    unresolved: list[str] = []
    try:
        argv = interpolate(list(scene["exclusive_command"]), _mapping(bound, scene_id))
    except ValueError as exc:
        text = str(exc)
        unresolved = text.split(":", 1)[1].split(",") if text.startswith("unresolved:") else [text]
        reasons.append("unresolved_placeholder")
    if argv:
        unresolved = leftover_placeholders(argv)
        if unresolved:
            reasons.append("unresolved_placeholder")
            argv = None
    unique_reasons = list(dict.fromkeys(reasons))
    ok = not unique_reasons and argv is not None
    return {
        "id": scene_id,
        "ok": ok,
        "argv": argv if ok else None,
        "status": "planned-not-run" if ok else "refused",
        "reasons": unique_reasons,
        "unresolved": unresolved,
        "runnable": False,
        "this_slice_execute": False,
        "simulated": contract["simulated"],
        "class": contract["class"],
        "budget_eligibility": contract["eligibility"],
        "formal_budget_allowed": contract["formal_budget_allowed"],
        "probe": contract.get("probe"),
        "dependencies": contract.get("runtime_deps") or [],
        "expected_behavior": contract.get("behavior_pass_when"),
        "unverified": contract.get("unverified") or [],
        "note": contract.get("notes"),
        "argv_resolved": argv is not None and not unresolved,
        "dependencies_assessed": {
            "pymupdf": bound.get("python_modules", {}).get("pymupdf") if scene_id in PYTHON_SCENES else "not_applicable",
            "tsx": bound["tsx"] is not None if scene_id in NODE_SCENES else "not_applicable",
            "blender": bool(bound["blender"]) if scene_id in BLENDER_SCENES else "not_applicable",
        },
    }


def resolve_plan(bound: dict[str, Any], *, scene_id: str | None = None) -> dict[str, Any]:
    if scene_id is not None:
        scenes = [resolve_scene(scene_id, bound)]
    else:
        scenes = [resolve_scene(row["id"], bound) for row in scenarios.SCENARIOS]
    refused = [row["id"] for row in scenes if not row["ok"]]
    return {
        "schema": "beian-r04-resolved-plan/v1",
        "historical_disposition": HISTORICAL_DISPOSITION,
        "bindings": {
            "repo": str(bound["repo"]),
            "out": str(bound["out"]),
            "python": str(bound["python"]),
            "node": str(bound["node"]) if bound["node"] else None,
            "npm": str(bound["npm"]) if bound["npm"] else None,
            "tsx": str(bound["tsx"]) if bound["tsx"] else None,
            "blender": str(bound["blender"]) if bound["blender"] else None,
            "probe_dir": str(bound["probe_dir"]),
        },
        "this_slice_executes_product": False,
        "scenes": scenes,
        "refused": refused,
        "all_ok": not refused,
        "note": (
            "argv is a plan only; synthetic-local/--repeat still run lightweight children; "
            "help/plan/matrix do not start Blender, Playwright, or 100MiB upload"
        ),
    }


def env_blender() -> str | None:
    value = os.environ.get("BEIAN_BLENDER", "").strip()
    return value or None
