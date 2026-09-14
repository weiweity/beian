#!/usr/bin/env python3
"""单轮外层身份回执 + cache 探针可用性评估。

只读原始测量 JSON，只写 round-receipt.json；**不补写、不改写**任何原始 payload。
Playwright 的 pass 不作为采样完整的证据；cache 探针缺失一律标 not_assessed。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "beian-q05-round-receipt/2"
SOURCE_FILES = [
    "VERSION",
    "apps/web/ui/e2e/q05Artifact.ts",
    "apps/web/ui/e2e/q05-prebuilt-artifact.spec.ts",
    "apps/web/ui/e2e/mockup-preview-upgrade.spec.ts",
    "apps/web/ui/playwright.config.ts",
    "TESTING.md",
    "scripts/resource-stress/cli.py",
    "scripts/resource-stress/protocol.py",
]
RAW_PAYLOADS = [
    "measure/q05-heap-raf.json",
    "measure/rf09-preview-measure-20260907.json",
]
EXPECTED_STAGES = 11


def sha256_file(path: Path) -> str | None:
    if not path.is_file() or path.is_symlink():
        return None
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fingerprint(files: dict[str, str]) -> str:
    """与 e2e/q05Artifact.ts::fingerprint 同构：label\\0hash\\n，按 label 升序。"""
    h = hashlib.sha256()
    for label in sorted(files):
        h.update(label.encode("utf-8"))
        h.update(b"\0")
        h.update(str(files[label]).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def iso(epoch: int | None) -> str | None:
    if epoch is None:
        return None
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def mtime_iso(path: Path) -> str | None:
    if not path.is_file():
        return None
    return iso(int(path.stat().st_mtime))


def git(repo: Path, *args: str) -> str | None:
    try:
        out = subprocess.run(["git", "-C", str(repo), *args],
                             capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def describe_raw(round_dir: Path, rel: str) -> dict:
    path = round_dir / rel
    return {
        "path": rel,
        "status": "present" if path.is_file() else "absent",
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size if path.is_file() else None,
        "mtime_utc": mtime_iso(path),
    }


def cache_assessment(round_dir: Path) -> dict:
    """按阶段记录 cache 探针可用性。缺失 = not_assessed，不以 Playwright pass 代替。"""
    rel = "measure/q05-heap-raf.json"
    path = round_dir / rel
    base = {
        "source": rel,
        # 探针可用性只有两种：assessed / not_assessed。原始 payload 缺失也归 not_assessed，
        # 来源状态另记 source_status，避免把「没采到」写成「采到了」。
        "status": "not_assessed",
        "source_status": "absent",
        "stages": [],
        "stages_total": 0,
        "stages_assessed": 0,
        "stages_not_assessed": 0,
        "cache_series_present": False,
        "expected_stages": EXPECTED_STAGES,
        "assertion_dependency": (
            "spec 仅在 cacheSizes.length >= 2 时才断言 peak < 40；"
            "probe 不可用时该断言静默跳过，用例仍 pass。"
        ),
        "note": "Playwright 通过 != 采样完整。not_assessed 表示该阶段 cache 探针不可用，不得据此声称 cache 序列已采到。",
    }
    if not path.is_file():
        base["note"] += " 原始 payload 缺失，整轮 cache 探针记 not_assessed。"
        return base
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        base["source_status"] = "unreadable"
        base["error"] = type(exc).__name__
        return base

    stages = payload.get("stages") if isinstance(payload, dict) else None
    if not isinstance(stages, list):
        base["source_status"] = "unreadable"
        base["error"] = "payload 无 stages 数组"
        return base

    rows = []
    for index, stage in enumerate(stages):
        row = stage if isinstance(stage, dict) else {}
        probe_row = row.get("heapAfterGc") or row.get("heap") or {}
        cache = probe_row.get("cache") if isinstance(probe_row, dict) else None
        cache = cache if isinstance(cache, dict) else {}
        size = cache.get("size")
        probe = cache.get("probe")
        ok = probe is True and type(size) is int and size >= 0
        rows.append({
            "index": index,
            "phase": row.get("phase"),
            "probe": probe if isinstance(probe, bool) else None,
            "size": size if type(size) is int and size >= 0 else None,
            "status": "assessed" if ok else "not_assessed",
        })
    assessed = sum(1 for r in rows if r["status"] == "assessed")
    base.update({
        "status": "assessed" if assessed == len(rows) and rows else "not_assessed",
        "source_status": "present",
        "stages": rows,
        "stages_total": len(rows),
        "stages_assessed": assessed,
        "stages_not_assessed": len(rows) - assessed,
        # 与 spec 的 if (cacheSizes.length >= 2) 门槛对齐
        "cache_series_present": assessed >= 2,
    })
    return base


def rss_wall_files(round_dir: Path) -> list[dict]:
    root = round_dir / "rss-wall"
    if not root.is_dir():
        return []
    out = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            out.append({
                "path": str(path.relative_to(round_dir)),
                "sha256": sha256_file(path),
                "bytes": path.stat().st_size,
            })
    return out


def artifact_block(repo: Path, artifact_dir: Path) -> dict:
    sidecar = artifact_dir / ".beian-q05-ui-identity.json"
    block: dict = {
        "dir": str(artifact_dir),
        "sidecar": sidecar.name,
        "sidecar_sha256": sha256_file(sidecar),
        "readable": sidecar.is_file(),
    }
    if not sidecar.is_file():
        block["note"] = "预构建 sidecar 缺失，无法核对产物身份。"
        return block
    try:
        identity = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        block["readable"] = False
        block["error"] = type(exc).__name__
        return block

    if not isinstance(identity, dict) or identity.get("schema") != "beian-q05-ui-prebuilt/1":
        block["readable"] = False
        return block

    sources = identity.get("sources") or {}
    manifest = identity.get("manifest") or {}
    assets: dict[str, str] = {}
    assets_dir = artifact_dir / "assets"
    if assets_dir.is_dir():
        for path in sorted(assets_dir.iterdir()):
            if path.is_file():
                assets[path.name] = sha256_file(path) or ""
    other: dict[str, str] = {}
    for path in sorted(artifact_dir.rglob("*")):
        if path.is_file() and path.name != sidecar.name:
            rel = str(path.relative_to(artifact_dir))
            if rel != "index.html" and not rel.startswith("assets/"):
                other[rel] = sha256_file(path) or ""

    # 与 q05Artifact.ts::describeSource 同构：spec payload 里报的就是这两个派生指纹。
    inputs_sha = fingerprint(sources) if sources else None
    artifact_sha = fingerprint(
        {"index.html": manifest.get("indexHtml", ""),
         **{f"assets/{name}": value for name, value in (manifest.get("assets") or {}).items()}}
    ) if manifest else None

    block.update({
        "gitHead": identity.get("gitHead"),
        "gitHead_matches_repo_head": identity.get("gitHead") == git(repo, "rev-parse", "HEAD"),
        "inputsSha_from_sidecar_sources": inputs_sha,
        "artifactSha_from_sidecar_manifest": artifact_sha,
        "lock_sha256_recorded": (identity.get("lock") or {}).get("sha256"),
        "source_file_count": len(sources),
        "sources_match_disk": sources == build_inputs(repo) and any(k.startswith("src/") for k in sources)
        and all(isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) for v in sources.values()),
        "lock_matches_disk": (identity.get("lock") or {}).get("sha256") == sha256_file(repo / "package-lock.json"),
        "manifest_matches_disk": recovered_manifest_match(artifact_dir, manifest),
        "index_html_sha256_on_disk": sha256_file(artifact_dir / "index.html"),
        "index_html_sha256_recorded": manifest.get("indexHtml"),
        "assets_sha256_on_disk": assets,
        "assets_sha256_recorded": manifest.get("assets"),
        "other_files_sha256": other,
        "artifactSha_covers": "index.html + assets/*（不含 brand/* 等同源非 assets 资源）",
    })
    return block


def build_inputs(repo: Path) -> dict[str, str | None]:
    """Mirror q05Artifact.ts build-input selection, not an alternative build/stamping entry."""
    ui = repo / "apps/web/ui"
    files = [ui / name for name in ("index.html", "vite.config.ts", "package.json", "tsconfig.json", "package-lock.json")]
    files.append(repo / "package-lock.json")
    for name in ("src", "public"):
        root = ui / name
        if root.is_symlink():
            raise ValueError("symlink_input")
        for directory, dirs, names in os.walk(root, followlinks=False):
            # Mirror q05Artifact.ts walkFiles: skip node_modules and dot names
            # before symlink checks, then fail closed on remaining symlinks.
            dirs[:] = [child for child in dirs if child != "node_modules" and not child.startswith(".")]
            names = [child for child in names if child != "node_modules" and not child.startswith(".")]
            if any((Path(directory) / child).is_symlink() for child in [*dirs, *names]):
                raise ValueError("symlink_input")
            files.extend(Path(directory) / child for child in names)
    return {os.path.relpath(p, ui).replace(os.sep, "/"): sha256_file(p) for p in files
            if p.is_file() and not p.name.endswith((".test.ts", ".test.tsx"))}


def recovered_manifest_match(artifact_dir: Path, manifest: dict) -> bool | None:
    """磁盘上的 index.html + assets/* 是否与 sidecar manifest 记录一致。"""
    if not manifest:
        return None
    if sha256_file(artifact_dir / "index.html") != manifest.get("indexHtml"):
        return False
    recorded = manifest.get("assets") or {}
    assets_dir = artifact_dir / "assets"
    on_disk = {}
    if assets_dir.is_dir():
        for path in sorted(assets_dir.iterdir()):
            if path.is_file():
                on_disk[path.name] = sha256_file(path)
    return on_disk == recorded


def payload_crosscheck(round_dir: Path, artifact: dict, repo: Path) -> dict:
    """把原始 payload 里自报的 artifact 身份与外层 sidecar/工作树对一遍。

    注意：用例 A 的 payload 不写 artifact/gitHead（见 REVIEW.md F1），因此这里只对
    用例 B 的 payload 交叉核对；用例 A 只能靠外层回执归属。
    """
    out: dict = {
        "source": "measure/q05-heap-raf.json",
        "status": "absent",
        "note": "用例 B payload 自带 gitHead/artifact；用例 A payload 无身份字段，只能由本回执外层归属。",
    }
    path = round_dir / "measure" / "q05-heap-raf.json"
    if not path.is_file():
        return out
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        out["status"] = "unreadable"
        out["error"] = str(exc)
        return out
    reported = payload.get("artifact") or {}
    head = git(repo, "rev-parse", "HEAD")
    out.update({
        "status": "checked",
        "mode_reported": reported.get("mode"),
        "gitHead_reported": payload.get("gitHead"),
        "gitHead_matches_repo_head": payload.get("gitHead") == head,
        "inputsSha_reported": reported.get("inputsSha"),
        "inputsSha_matches_sidecar": reported.get("inputsSha") == artifact.get("inputsSha_from_sidecar_sources"),
        "artifactSha_reported": reported.get("artifactSha"),
        "artifactSha_matches_sidecar": reported.get("artifactSha") == artifact.get("artifactSha_from_sidecar_manifest"),
        "thisSpec_reported": (payload.get("sources") or {}).get("thisSpec"),
        "thisSpec_matches_disk": (payload.get("sources") or {}).get("thisSpec") == sha256_file(
            repo / "apps/web/ui/e2e/mockup-preview-upgrade.spec.ts"),
        "whole_command_includes_ui_build": (payload.get("measurement_windows") or {})
            .get("command_rss_wall", {}).get("includes_ui_build"),
    })
    return out


def snapshot(repo: Path, artifact_dir: Path) -> dict:
    return {
        "repo": {
            "worktree": str(repo),
            "branch": git(repo, "rev-parse", "--abbrev-ref", "HEAD"),
            "git_head": git(repo, "rev-parse", "HEAD"),
            "status_porcelain": git(repo, "status", "--porcelain"),
            "source_files_sha256": {rel: sha256_file(repo / rel) for rel in SOURCE_FILES},
        },
        "artifact": artifact_block(repo, artifact_dir),
        "tools": {name: sha256_file(Path(__file__).with_name(name)) for name in
                  ("q05_receipt.py", "q05_rounds.sh", "q05_command.sh", "cli.py", "protocol.py")},
    }


def snapshot_errors(state: dict) -> list[str]:
    reasons = []
    repo, artifact = state["repo"], state["artifact"]
    if not repo["git_head"] or repo["status_porcelain"] != "" or not all(repo["source_files_sha256"].values()):
        reasons.append("repo_identity_missing_or_dirty")
    if not all(state["tools"].values()):
        reasons.append("tool_identity_missing")
    for field in ("readable", "gitHead_matches_repo_head", "manifest_matches_disk", "sources_match_disk", "lock_matches_disk"):
        if artifact.get(field) is not True:
            reasons.append(f"artifact:{field}")
    if not artifact.get("sidecar_sha256") or not artifact.get("index_html_sha256_on_disk"):
        reasons.append("artifact_identity_missing")
    assets = artifact.get("assets_sha256_on_disk") or {}
    if not all(assets.values()) or not any(k.endswith(".js") for k in assets) or not any(k.endswith(".css") for k in assets):
        reasons.append("artifact_assets_missing")
    return reasons


def gate(receipt: dict, before_file: Path | None, state: dict) -> dict:
    reasons = snapshot_errors(state)
    if receipt["window_confirmed"] is not True or receipt["run"]["exit_code"] != 0:
        reasons.append("window_or_command_failed")
    if not receipt["run"]["command_file_sha256"] or not receipt["run"]["command_text"].strip():
        reasons.append("command_missing")
    if before_file is None or not before_file.is_file():
        reasons.append("before_snapshot_missing")
    elif json.loads(before_file.read_text(encoding="utf-8")) != state:
        reasons.append("identity_changed_during_round")
    for raw in receipt["raw_payloads"]:
        if raw["status"] != "present" or not raw["sha256"] or not raw["bytes"]:
            reasons.append(f"raw_missing:{raw['path']}")
    cross = receipt["payload_identity_crosscheck"]
    for field in ("gitHead_matches_repo_head", "inputsSha_matches_sidecar", "artifactSha_matches_sidecar", "thisSpec_matches_disk"):
        if cross.get(field) is not True:
            reasons.append(f"payload:{field}")
    if cross.get("mode_reported") != "prebuilt-external" or cross.get("whole_command_includes_ui_build") is not False:
        reasons.append("not_prebuilt_measurement")
    # Probe absence on e.g. left-page is honest not_assessed, not an identity failure.
    if receipt["cache_probe_assessment"]["stages_total"] != EXPECTED_STAGES:
        reasons.append("stage_count_mismatch")
    root = Path(receipt["round_dir"])
    try:
        payload_a = json.loads((root / RAW_PAYLOADS[1]).read_text(encoding="utf-8"))
        if not isinstance(payload_a, dict) or not isinstance(payload_a.get("samples"), list) or len(payload_a["samples"]) != 6:
            reasons.append("sample_count_mismatch")
    except (OSError, ValueError):
        reasons.append("payload_a_unreadable")
    metrics_path = root / "rss-wall" / f"q05-round{receipt['round']}.metrics.json"
    try:
        metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
        if not sha256_file(metrics_path) or not isinstance(metrics, dict) or \
                type(metrics.get("exit_code")) is not int or metrics["exit_code"] != 0 or \
                metrics.get("cancelled") is not False or metrics.get("launch_error") or \
                metrics.get("measurement_errors") or not isinstance(metrics.get("samples"), list) or \
                not metrics["samples"] or not all(isinstance(sample, dict) for sample in metrics["samples"]):
            reasons.append("rss_wall_measurement_failed")
    except (OSError, ValueError):
        reasons.append("rss_wall_missing")
    return {"passed": not reasons, "reasons": reasons, "budget_valid": False}


def write_new(path: Path, value: dict) -> None:
    with path.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def external_output(repo: Path, artifact: Path, output: Path) -> bool:
    listing = git(repo, "worktree", "list", "--porcelain")
    if listing is None:
        return False
    roots = [repo, artifact, *(Path(line[9:]) for line in listing.splitlines() if line.startswith("worktree "))]
    target = output.resolve()
    return all(not target.is_relative_to(root.resolve()) for root in roots)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--round-dir")
    parser.add_argument("--round-number", type=int)
    parser.add_argument("--exit-code", type=int)
    parser.add_argument("--started-epoch", type=int)
    parser.add_argument("--ended-epoch", type=int)
    parser.add_argument("--command-file")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--artifact-dir", required=True)
    parser.add_argument("--window-confirmed", default="0")
    parser.add_argument("--before-file")
    parser.add_argument("--snapshot-only", action="store_true")
    parser.add_argument("--output-file")
    parser.add_argument("--check-output")
    args = parser.parse_args(argv)

    if args.check_output:
        return 0 if external_output(Path(args.repo), Path(args.artifact_dir), Path(args.check_output)) else 2

    if args.snapshot_only:
        if not args.output_file:
            parser.error("--snapshot-only requires --output-file")
        if not external_output(Path(args.repo), Path(args.artifact_dir), Path(args.output_file)):
            return 2
        try:
            state = snapshot(Path(args.repo).resolve(), Path(args.artifact_dir).resolve())
            errors = snapshot_errors(state)
            write_new(Path(args.output_file), state)
            return 5 if errors else 0
        except (OSError, ValueError, TypeError, AttributeError):
            return 5
    if any(getattr(args, name) is None for name in (
        "round_dir", "round_number", "exit_code", "started_epoch", "ended_epoch", "command_file"
    )):
        parser.error("receipt requires round, command and timing arguments")
    if args.round_number < 1 or args.started_epoch < 0 or args.ended_epoch < args.started_epoch:
        parser.error("invalid round or timing")

    round_dir = Path(args.round_dir).resolve()
    repo = Path(args.repo).resolve()
    if not external_output(repo, Path(args.artifact_dir), round_dir):
        return 2
    command_file = Path(args.command_file)

    command_text = command_file.read_text(encoding="utf-8") if command_file.is_file() else ""

    try:
        return record(args, round_dir, repo, command_file, command_text)
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        # No JSON bodies or arbitrary values in errors; never overwrite existing evidence.
        print(f"RECEIPT_REFUSED:{type(exc).__name__}", file=sys.stderr)
        return 5


def record(args, round_dir: Path, repo: Path, command_file: Path, command_text: str) -> int:
    state = snapshot(repo, Path(args.artifact_dir).resolve())
    receipt = {
        "schema": SCHEMA,
        "round": args.round_number,
        "round_dir": str(round_dir),
        "generated_at_utc": iso(int(datetime.now(tz=timezone.utc).timestamp())),
        "window_confirmed": args.window_confirmed == "1",
        "run": {
            "started_at_utc": iso(args.started_epoch),
            "ended_at_utc": iso(args.ended_epoch),
            "wall_seconds": max(0, args.ended_epoch - args.started_epoch),
            "command_file": str(command_file),
            "command_file_sha256": sha256_file(command_file),
            "command_text": command_text,
            "exit_code": args.exit_code,
            "retried": False,
        },
        "repo": state["repo"] | {
            "version": (repo / "VERSION").read_text(encoding="utf-8").strip()
            if (repo / "VERSION").is_file() else None,
        },
        "artifact": state["artifact"],
        "raw_payloads": [describe_raw(round_dir, rel) for rel in RAW_PAYLOADS],
        "cache_probe_assessment": cache_assessment(round_dir),
        "payload_identity_crosscheck": None,  # 填充于下方（依赖 artifact 块）
        "rss_wall_files": rss_wall_files(round_dir),
        "originals_untouched": True,
        "note": (
            "本回执只读原始测量 payload 并另存为独立文件；原始 payload 未被改写或补写。"
            "身份字段来自当轮工作树与预构建 sidecar，不写回 payload。"
        ),
    }

    receipt["payload_identity_crosscheck"] = payload_crosscheck(round_dir, receipt["artifact"], repo)
    receipt["gate"] = gate(receipt, Path(args.before_file) if args.before_file else None, state)
    receipt["tools"] = state["tools"]

    out = round_dir / "round-receipt.json"
    write_new(out, receipt)
    print(str(out))
    return 0 if receipt["gate"]["passed"] else 5


if __name__ == "__main__":
    sys.exit(main())
