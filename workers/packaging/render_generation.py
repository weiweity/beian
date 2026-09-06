#!/usr/bin/env python3
"""Isolated render-candidate substrate for RF-03C1.

Trusted job root and candidate directory enter; RF-02 validation, exclusive
prepare, ``run_blender_job``, and on-disk evidence stay inside this module.
It does not seal ready generations, switch current, open HTTP, or rewrite the
renderer.  Production quality remains unwired.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import struct
import sys
import tempfile
import zlib
from pathlib import Path
from typing import Any, Mapping

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pipeline as packaging_pipeline  # noqa: E402
from glb_verify import _decode_png_rgba, load_glb_artifact  # noqa: E402
from render_contract import (  # noqa: E402
    OPTIONAL_RENDERER_OUTPUT_KEYS,
    RenderContractError,
    SEMANTIC_FACES,
    blender_execution_plan,
    canonical_sha256,
    persistable_plan_from_bound_job,
    render_plan_for_resolved_job,
    validate_job_asset_contract,
    validate_job_output_contract,
)

REQUEST_SCHEMA = "packaging-render-generation-request/1"
RESULT_SCHEMA = "packaging-render-generation-result/1"
IDENTITY_SCHEMA = "packaging-render-generation-identity/1"
ACTIONS = ("validate", "prepare", "render-candidate")
MODES = ("preserve", "legacy_relight", "upgrade")
REQUEST_KEYS = frozenset(
    {
        "schema",
        "action",
        "job_root",
        "candidate_dir",
        "mode",
        "expected_source_sha256",
        "expected_asset_sha256",
        "studio_adjustment",
        "blender_executable",
    }
)
STUDIO_KEYS = frozenset({"product_light", "background_light"})
MAX_PATH_CHARS = 1024
MAX_REQUEST_BYTES = 64 * 1024
STUDIO_LIGHT_LOWER = 0.1
STUDIO_LIGHT_UPPER = 4.0
SOURCE_RESOLVED_NAME = "resolved_job.json"
READY_MANIFEST_NAME = "generation.json"
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
REQUIRED_STILL_KEYS = ("front_right", "back_left", "glb")
REQUIRED_CARD_KEYS = ("front_right_card", "back_left_card")
QUALITY_UNWIRED = {
    "schema": "packaging-render-quality/1",
    "status": "unwired",
    "wired": False,
    "runtime_gate": "pending",
    "production_ready": False,
    "note": "RF-03C1 未接线真实质量门；不能当作 runtime quality pass 或 production-ready",
}


class RenderGenerationError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "render_generation_invalid",
        cause: str = "",
        fix: str = "",
    ) -> None:
        super().__init__(message)
        self.code = str(code).strip() or "render_generation_invalid"
        self.cause = str(cause or "").strip()
        self.fix = str(fix or "").strip()

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ok": False,
            "schema": RESULT_SCHEMA,
            "code": self.code,
            "error": str(self)[:80],
            "quality": dict(QUALITY_UNWIRED),
        }
        if self.cause:
            payload["cause"] = self.cause[:240]
        if self.fix:
            payload["fix"] = self.fix[:160]
        return payload


def _emit(stage: str) -> None:
    packaging_pipeline.emit_stage(stage)


def _problem(message: str, *, cause: str, fix: str) -> None:
    print(
        json.dumps(
            {"problem": message[:80], "cause": cause[:240], "fix": fix[:160]},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        file=sys.stderr,
        flush=True,
    )


def _fail(
    message: str,
    *,
    code: str = "render_generation_invalid",
    cause: str = "",
    fix: str = "",
) -> None:
    raise RenderGenerationError(message, code=code, cause=cause, fix=fix)


def _from_contract(error: RenderContractError) -> RenderGenerationError:
    return RenderGenerationError(
        str(error),
        code=error.code,
        cause="rf02_contract",
        fix="只接受通过 RF-02 验证的 persistable plan，不能用 JSON.parse 或自报哈希代替",
    )


def _from_pipeline(error: packaging_pipeline.PipelineError) -> RenderGenerationError:
    return RenderGenerationError(
        str(error),
        code=error.code,
        cause=error.cause or "pipeline",
        fix=error.fix or "查看候选目录日志；源作业保持只读",
    )


def _sha256_bytes(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _require_sha(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _SHA256.fullmatch(value):
        _fail(f"{label} 必须是 sha256: 加 64 位小写十六进制", cause=label)
    return value


def _text(value: Any, label: str, *, allowed: tuple[str, ...] | None = None) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 128:
        _fail(f"{label} 必须是 1–128 字符文本", cause=label)
    if any(ch in value for ch in "\r\n\t"):
        _fail(f"{label} 不能含控制字符", cause=label)
    text = value.strip()
    if allowed is not None and text not in allowed:
        _fail(f"{label} 不受支持", cause=label, fix=f"只接受 {', '.join(allowed)}")
    return text


def _finite(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{label} 必须是有限数值", cause=label)
    number = float(value)
    if not (STUDIO_LIGHT_LOWER <= number <= STUDIO_LIGHT_UPPER):
        _fail(
            f"{label} 超出 0.1–4.0 预算",
            cause=label,
            fix="调灯只传有限的 product_light / background_light",
        )
    rounded = round(number, 6)
    return 0.0 if rounded == -0.0 else rounded


def _absolute_path(value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_PATH_CHARS:
        _fail(f"{label} 必须是不超过 {MAX_PATH_CHARS} 字符的绝对路径", cause=label)
    if any(ch in value for ch in "\r\n\t\x00"):
        _fail(f"{label} 不能含控制字符", cause=label)
    path = Path(value).expanduser()
    if not path.is_absolute():
        _fail(f"{label} 必须是绝对路径", cause=label, fix="由可信调用者指定根，不能从 payload 自报")
    return path


def _lstat(path: Path):
    try:
        return path.lstat()
    except FileNotFoundError:
        return None
    except NotADirectoryError:
        return None
    except OSError as error:
        _fail(f"无法读取路径 {path.name}", cause=str(error))


def _try_resolve(path: Path) -> Path | None:
    try:
        return path.resolve()
    except OSError:
        return None


def _is_dir(info) -> bool:
    return info is not None and stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)


def _is_reg(info) -> bool:
    return info is not None and stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode)


def _is_link(info) -> bool:
    return info is not None and stat.S_ISLNK(info.st_mode)


def _lexical(path: Path) -> Path:
    return Path(os.path.abspath(path.expanduser()))


def _norm(path: Path) -> str:
    return os.path.normcase(str(_lexical(path)))


def _is_descendant(full: Path, root: Path) -> bool:
    full_n = _norm(full)
    root_n = _norm(root)
    if full_n == root_n:
        return True
    prefix = root_n if root_n.endswith(os.sep) else root_n + os.sep
    return full_n.startswith(prefix)


def _system_tmp_roots() -> list[Path]:
    roots: list[Path] = []

    def add(raw: Path | str) -> None:
        path = _lexical(Path(raw))
        if path not in roots:
            roots.append(path)

    add(Path(tempfile.gettempdir()))
    if os.name != "nt":
        for item in ("/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"):
            add(item)
            real = _try_resolve(Path(item))
            if real is not None:
                add(real)
    real_tmp = _try_resolve(Path(tempfile.gettempdir()))
    if real_tmp is not None:
        add(real_tmp)
    return roots


def _configured_roots(job_root: Path) -> list[Path]:
    """Caller job_root plus system temp aliases. Never authorize an arbitrary link."""

    roots: list[Path] = []

    def add(raw: Path | None) -> None:
        if raw is None:
            return
        lexical = _lexical(raw)
        if lexical not in roots:
            roots.append(lexical)

    def add_with_real(raw: Path | None) -> None:
        add(raw)
        if raw is None:
            return
        real = _try_resolve(raw)
        if real is not None and real not in roots:
            roots.append(real)

    add_with_real(job_root)
    for item in _system_tmp_roots():
        add_with_real(item)
    return roots


def _select_root(target: Path, roots: list[Path]) -> Path:
    selected: Path | None = None
    for root in roots:
        if not _is_descendant(target, root):
            continue
        if selected is None or len(_norm(root)) > len(_norm(selected)):
            selected = root
    if selected is None:
        _fail(
            "路径不在可信根下",
            cause="untrusted_root",
            fix="job_root 与 candidate_dir 必须由可信调用者指定",
        )
    return selected


def _assert_trusted_ancestors(target: Path, roots: list[Path], *, must_exist: bool) -> None:
    full = _lexical(target)
    selected = _select_root(full, roots)
    rel = os.path.relpath(str(full), str(selected))
    if rel.startswith("..") or os.path.isabs(rel):
        _fail("路径逃出可信根", cause="untrusted_root")
    parts = Path(rel).parts
    cursor = selected
    info = _lstat(cursor)
    if info is None:
        _fail("可信根不存在", cause="root_missing")
    if _is_link(info):
        real = _try_resolve(cursor)
        allowed = {_norm(item) for item in roots}
        if real is None or _norm(real) not in allowed:
            _fail("拒绝符号链接根", cause="symlink_dir")
    elif not _is_dir(info):
        _fail("可信根不是普通目录", cause="root_not_dir")
    if parts == (".",) or parts == ():
        if must_exist and not _is_dir(info) and not _is_link(info):
            _fail("目录不是普通目录", cause="not_dir")
        return
    for index, part in enumerate(parts):
        cursor = cursor / part
        info = _lstat(cursor)
        last = index == len(parts) - 1
        if info is None:
            if last and not must_exist:
                return
            _fail("路径分量缺失", cause="path_missing")
        if _is_link(info):
            _fail(
                "拒绝路径中间或目标上的符号链接",
                cause="symlink_dir",
                fix="任意链接不得因指向可信根而获权",
            )
        if last and not must_exist:
            _fail("候选目录已存在", cause="candidate_exists", fix="每次独占新建私有候选目录")
        if not _is_dir(info):
            _fail("路径分量不是普通目录", cause="not_dir")


def _path_tokens(path: Path) -> set[tuple[Any, ...]]:
    tokens: set[tuple[Any, ...]] = {("case", _norm(path))}
    real = _try_resolve(path)
    if real is not None:
        tokens.add(("case", _norm(real)))
    info = _lstat(path)
    if info is None:
        return tokens
    if int(getattr(info, "st_ino", 0) or 0):
        tokens.add(("ino", int(info.st_dev), int(info.st_ino)))
    try:
        followed = path.stat()
    except OSError:
        return tokens
    if int(getattr(followed, "st_ino", 0) or 0):
        tokens.add(("ino", int(followed.st_dev), int(followed.st_ino)))
    return tokens


def _tokens_overlap(left: Path, right: Path) -> bool:
    return bool(_path_tokens(left) & _path_tokens(right))


def _has_ready_marker(directory: Path) -> bool:
    """A ready root is marked by generation.json, not by a ``g*`` basename."""

    return _lstat(directory / READY_MANIFEST_NAME) is not None


def _remember_path(paths: list[Path], seen: set[str], raw: Path | None) -> None:
    if raw is None:
        return
    lexical = _lexical(raw)
    key = _norm(lexical)
    if key not in seen:
        seen.add(key)
        paths.append(lexical)
    real = _try_resolve(raw)
    if real is None:
        return
    real_key = _norm(real)
    if real_key not in seen:
        seen.add(real_key)
        paths.append(real)


def _discover_ready_roots(job_root: Path) -> list[Path]:
    """Collect ready roots by on-disk markers. Do not follow directory links."""

    roots: list[Path] = []
    seen: set[str] = set()
    for dirpath, dirnames, _filenames in os.walk(job_root, followlinks=False):
        current = Path(dirpath)
        info = _lstat(current)
        if _is_link(info):
            dirnames[:] = []
            continue
        keep: list[str] = []
        for name in dirnames:
            child = current / name
            if _is_link(_lstat(child)):
                if _has_ready_marker(child):
                    _remember_path(roots, seen, child)
                continue
            keep.append(name)
        dirnames[:] = keep
        if _has_ready_marker(current):
            _remember_path(roots, seen, current)
    return roots


def _lineage_identities(path: Path) -> list[Path]:
    """Lexical ancestors plus resolved/symlink/case identities of ``path``."""

    identities: list[Path] = []
    seen: set[str] = set()
    pending = [_lexical(path)]
    real = _try_resolve(path)
    if real is not None:
        pending.append(real)
    while pending:
        cursor = pending.pop(0)
        while True:
            key = _norm(cursor)
            if key not in seen:
                seen.add(key)
                identities.append(cursor)
                info = _lstat(cursor)
                if _is_link(info):
                    linked = _try_resolve(cursor)
                    if linked is not None and _norm(linked) not in seen:
                        pending.append(linked)
            parent = cursor.parent
            if parent == cursor:
                break
            cursor = parent
    return identities


def _candidate_touches_ready(dest: Path, ready_roots: list[Path]) -> bool:
    """Reject dest if any lexical or real ancestor already has a ready marker.

    Marker checks follow the candidate lineage only. They are not limited to
    the source job_root and must not walk DATA_DIR. Source-job ``ready_roots``
    still catch alias, symlink, and inode overlap inside the calling job.
    """

    for node in _lineage_identities(dest):
        if _has_ready_marker(node):
            return True
        for ready in ready_roots:
            if _is_descendant(node, ready) or _tokens_overlap(node, ready):
                return True
    return False


def _iter_source_files(job_root: Path) -> list[Path]:
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(job_root, followlinks=False):
        current = Path(dirpath)
        info = _lstat(current)
        if _is_link(info):
            dirnames[:] = []
            continue
        dirnames[:] = [
            name
            for name in dirnames
            if not _is_link(_lstat(current / name))
        ]
        for name in filenames:
            path = current / name
            if _is_link(_lstat(path)):
                continue
            if _is_reg(_lstat(path)):
                files.append(path)
    return files


def _studio_adjustment(value: Any) -> dict[str, float] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping) or isinstance(value, (str, bytes, list)):
        _fail("studio_adjustment 必须是对象", cause="studio_adjustment")
    extra = sorted(str(key) for key in value if key not in STUDIO_KEYS)
    if extra:
        _fail(
            "studio_adjustment 含未知字段",
            cause="studio_adjustment",
            fix="只传 product_light / background_light",
        )
    product = value.get("product_light", 1)
    background = value.get("background_light", 1)
    return {
        "product_light": _finite(product, "studio_adjustment.product_light"),
        "background_light": _finite(background, "studio_adjustment.background_light"),
    }


def parse_request(payload: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        _fail("请求必须是 JSON 对象")
    extra = sorted(str(key) for key in payload if key not in REQUEST_KEYS)
    if extra:
        _fail(
            "请求含未知字段",
            cause="unknown_fields",
            fix="不要传 profile、project_dir、assets 或输出路径",
        )
    if payload.get("schema") != REQUEST_SCHEMA:
        _fail("请求 schema 不受支持", cause="schema")
    action = _text(payload.get("action"), "action", allowed=ACTIONS)
    mode = _text(payload.get("mode"), "mode", allowed=MODES)
    job_root = _absolute_path(payload.get("job_root"), "job_root")
    expected_source = _require_sha(payload.get("expected_source_sha256"), "expected_source_sha256")
    raw_assets = payload.get("expected_asset_sha256")
    if not isinstance(raw_assets, Mapping):
        _fail("expected_asset_sha256 必须是六面对象", cause="expected_asset_sha256")
    extra_faces = sorted(str(key) for key in raw_assets if key not in SEMANTIC_FACES)
    if extra_faces:
        _fail("expected_asset_sha256 含未知面", cause="expected_asset_sha256")
    missing_faces = [face for face in SEMANTIC_FACES if face not in raw_assets]
    if missing_faces:
        _fail("expected_asset_sha256 缺少六面", cause="expected_asset_sha256")
    expected_assets = {
        face: _require_sha(raw_assets[face], f"expected_asset_sha256.{face}")
        for face in SEMANTIC_FACES
    }
    candidate_dir = None
    blender = None
    if action in {"prepare", "render-candidate"}:
        if "candidate_dir" not in payload:
            _fail("prepare/render-candidate 必须指定 candidate_dir")
        candidate_dir = _absolute_path(payload.get("candidate_dir"), "candidate_dir")
    elif "candidate_dir" in payload and payload.get("candidate_dir") not in (None, ""):
        candidate_dir = _absolute_path(payload.get("candidate_dir"), "candidate_dir")
    if action == "render-candidate":
        blender = _absolute_path(payload.get("blender_executable"), "blender_executable")
    elif "blender_executable" in payload and payload.get("blender_executable") not in (None, ""):
        blender = _absolute_path(payload.get("blender_executable"), "blender_executable")
    return {
        "action": action,
        "mode": mode,
        "job_root": job_root,
        "candidate_dir": candidate_dir,
        "expected_source_sha256": expected_source,
        "expected_asset_sha256": expected_assets,
        "studio_adjustment": _studio_adjustment(payload.get("studio_adjustment")),
        "blender_executable": blender,
    }


def _source_resolved_path(job_root: Path) -> Path:
    return _lexical(job_root) / SOURCE_RESOLVED_NAME


def read_source_job(job_root: Path) -> tuple[bytes, dict[str, Any], Path]:
    root = _lexical(job_root)
    resolved_path = _source_resolved_path(root)
    info = _lstat(resolved_path)
    if _is_link(info):
        _fail("源 resolved_job.json 不能是符号链接", cause="source_symlink")
    if not _is_reg(info):
        _fail("源 resolved_job.json 缺失", cause="source_missing", fix="只读合成 fixture 的 resolved_job.json")
    raw = resolved_path.read_bytes()
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail("源 resolved_job.json 不是 JSON", cause=str(error), code="render_contract_invalid")
    if not isinstance(payload, dict):
        _fail("源 resolved_job.json 必须是对象", code="render_contract_invalid")
    return raw, payload, resolved_path


def bind_source_job(
    job: dict[str, Any], job_root: Path, resolved_path: Path
) -> dict[str, Any]:
    bound = dict(job)
    bound["project_dir"] = str(_lexical(job_root))
    bound["resolved_job_path"] = str(resolved_path)
    return bound


def verify_source_bindings(
    *,
    job_root: Path,
    raw: bytes,
    job: dict[str, Any],
    expected_source_sha256: str,
    expected_asset_sha256: Mapping[str, str],
) -> dict[str, str]:
    actual_source = _sha256_bytes(raw)
    if actual_source != expected_source_sha256:
        _fail(
            "源 resolved_job 字节身份与期望不一致",
            cause="source_sha_mismatch",
            fix="磁盘实际路径、内存计划与期望 SHA 必须闭合",
        )
    try:
        validate_job_output_contract(job, project_dir=job_root)
        validate_job_asset_contract(job, project_dir=job_root)
    except RenderContractError as error:
        raise _from_contract(error) from error
    assets = job.get("assets") if isinstance(job.get("assets"), Mapping) else {}
    actual_assets: dict[str, str] = {}
    for face in SEMANTIC_FACES:
        path = Path(str(assets[face]))
        if _is_link(_lstat(path)):
            _fail("印刷面贴图不能是符号链接", cause=f"assets.{face}")
        digest = _sha256_file(path)
        actual_assets[face] = digest
        if digest != expected_asset_sha256[face]:
            _fail(
                "六面资产身份与期望不一致",
                cause=f"asset_sha_{face}",
                fix="缺失或篡改的资产在启动前拒绝",
            )
    return actual_assets


def plan_for_mode(job: Mapping[str, Any], mode: str) -> dict[str, Any]:
    if mode == "upgrade":
        _fail(
            "upgrade 所需的另一套已锁定视觉语义尚未实现",
            code="render_generation_unsupported",
            cause="upgrade_unwired",
            fix="本刀只交付 preserve / legacy_relight 保留现有合同并允许调灯",
        )
    if mode == "preserve" and job.get("render_spec") is None:
        _fail(
            "preserve 要求源作业已有完整 render spec，不能合成兼容合同",
            code="render_contract_invalid",
            cause="preserve_requires_spec",
        )
    try:
        return render_plan_for_resolved_job(job)
    except RenderContractError as error:
        raise _from_contract(error) from error


def candidate_identity_sha(
    *,
    source_plan_identity: str,
    mode: str,
    studio_adjustment: Mapping[str, float] | None,
) -> str:
    return canonical_sha256(
        {
            "schema": IDENTITY_SCHEMA,
            "source_plan_identity": source_plan_identity,
            "mode": mode,
            "studio_adjustment": dict(studio_adjustment) if studio_adjustment else None,
        }
    )


def assert_candidate_isolated(
    *,
    job_root: Path,
    candidate_dir: Path,
    source_job: Mapping[str, Any],
) -> None:
    root = _lexical(job_root)
    dest = _lexical(candidate_dir)
    if _norm(dest) == _norm(root):
        _fail("候选目录不能与源 root 重叠", cause="candidate_overlaps_source")
    ready_roots = _discover_ready_roots(root)
    if _candidate_touches_ready(dest, ready_roots):
        _fail(
            "候选目录不能落在 ready 根或其后代",
            cause="candidate_points_at_ready",
            fix="候选只能建在 job/.render-generations/.candidate 或独立目录，不能进 ready",
        )
    parent = dest.parent
    roots = _configured_roots(root)
    _assert_trusted_ancestors(root, roots, must_exist=True)
    _assert_trusted_ancestors(parent, roots, must_exist=True)
    _assert_trusted_ancestors(dest, roots, must_exist=False)
    reserved = [_source_resolved_path(root)]
    assets = source_job.get("assets") if isinstance(source_job.get("assets"), Mapping) else {}
    for face in SEMANTIC_FACES:
        raw = assets.get(face)
        if str(raw or "").strip():
            reserved.append(Path(str(raw)))
    outputs = source_job.get("outputs") if isinstance(source_job.get("outputs"), Mapping) else {}
    for raw in outputs.values():
        if str(raw or "").strip():
            reserved.append(Path(str(raw)))
    for extra in ("job.json", "pipeline_result.json", "blender.log", "blender_result.json"):
        reserved.append(root / extra)
    for path in reserved:
        if _tokens_overlap(dest, path):
            _fail("候选目录与源文件身份重叠", cause="candidate_overlaps_source")


def mkdir_exclusive(candidate_dir: Path) -> None:
    dest = _lexical(candidate_dir)
    info = _lstat(dest)
    if info is not None:
        _fail(
            "拒绝覆盖既存候选",
            cause="candidate_exists",
            fix="每次独占新建；异常不递归删除源或其他候选",
        )
    try:
        os.mkdir(dest, 0o700)
    except FileExistsError:
        _fail("拒绝覆盖既存候选", cause="candidate_exists")
    except OSError as error:
        _fail("无法创建候选目录", cause=str(error))
    created = _lstat(dest)
    if _is_link(created) or not _is_dir(created):
        _fail("候选目录创建后不是普通目录", cause="candidate_not_dir")


def apply_plan_to_job(job: dict[str, Any], plan: Mapping[str, Any]) -> None:
    job["render_spec"] = plan["spec"]
    job["render"] = plan["render"]
    job.update(plan["identity"])


def copy_candidate_assets(
    source_job: Mapping[str, Any],
    candidate_dir: Path,
    expected_asset_sha256: Mapping[str, str],
) -> dict[str, str]:
    """Bind Blender to verified private bytes, not mutable source paths.

    Copy and hash the same byte stream; re-read the completed destination so
    a source replacement or failed/changed copy cannot inherit an earlier SHA.
    Failed preparation stays inside this exclusively owned candidate.
    """

    assets_dir = candidate_dir / "assets"
    assets_dir.mkdir(mode=0o700)
    copied: dict[str, str] = {}
    for face in SEMANTIC_FACES:
        source_path = Path(str(source_job["assets"][face]))
        before = source_path.lstat()
        if not _is_reg(before):
            _fail("候选贴图源不是普通文件", cause=f"asset_snapshot_{face}")
        dest = assets_dir / f"panel_{face}.png"
        digest = hashlib.sha256()
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        with os.fdopen(os.open(source_path, flags), "rb") as source:
            opened = os.fstat(source.fileno())
            if not _is_reg(opened) or (before.st_dev, before.st_ino) != (
                opened.st_dev, opened.st_ino
            ):
                _fail("复制前源贴图身份已变化", cause=f"asset_snapshot_{face}")
            with dest.open("xb") as target:
                while chunk := source.read(1024 * 1024):
                    target.write(chunk)
                    digest.update(chunk)
        expected = expected_asset_sha256[face]
        if "sha256:" + digest.hexdigest() != expected or _sha256_file(dest) != expected:
            _fail(
                "候选贴图字节与期望不一致",
                cause=f"asset_snapshot_{face}",
                fix="源贴图变化或复制失败，拒绝启动；重新读取源身份后创建新候选",
            )
        copied[face] = str(dest)
    return copied


def prepare_candidate_job(
    *,
    source_job: Mapping[str, Any],
    plan: Mapping[str, Any],
    candidate_dir: Path,
    studio_adjustment: Mapping[str, float] | None,
    expected_asset_sha256: Mapping[str, str],
) -> dict[str, Any]:
    remapped = packaging_pipeline.remap_job_outputs_to_candidate(source_job, candidate_dir)
    remapped["assets"] = copy_candidate_assets(
        source_job, candidate_dir, expected_asset_sha256
    )
    apply_plan_to_job(remapped, plan)
    if studio_adjustment is not None:
        remapped["studio_adjustment"] = dict(studio_adjustment)
    outputs = remapped.get("outputs") if isinstance(remapped.get("outputs"), Mapping) else {}
    source_outputs = source_job.get("outputs") if isinstance(source_job.get("outputs"), Mapping) else {}
    for key, raw in outputs.items():
        dest = Path(str(raw))
        if not _is_descendant(dest, candidate_dir):
            _fail("候选输出必须落在候选目录内", cause=f"outputs.{key}")
        for source_raw in source_outputs.values():
            if str(source_raw or "").strip() and _tokens_overlap(dest, Path(str(source_raw))):
                _fail("候选输出不能覆盖源成片", cause=f"outputs.{key}")
        if _tokens_overlap(dest, _source_resolved_path(Path(str(source_job["project_dir"])))):
            _fail("候选输出不能覆盖源合同", cause=f"outputs.{key}")
    return remapped


def _regular_file(path: Path) -> bool:
    info = _lstat(path)
    return (not _is_link(info)) and _is_reg(info) and info.st_size > 0


def _png_structurally_ok(path: Path) -> bool:
    """Reuse glb_verify's PNG decoder. Magic-only / truncated files fail."""

    info = _lstat(path)
    if _is_link(info) or not _is_reg(info) or info.st_size <= 0:
        return False
    try:
        decoded = _decode_png_rgba(path.read_bytes())
    except (OSError, ValueError, zlib.error, struct.error):
        return False
    return (
        isinstance(decoded, dict)
        and int(decoded.get("width") or 0) > 0
        and int(decoded.get("height") or 0) > 0
    )


def _glb_structurally_ok(path: Path) -> bool:
    """Header + declared length + chunk alignment + JSON object. Not geometry QA."""

    info = _lstat(path)
    if _is_link(info) or not _is_reg(info) or info.st_size <= 0:
        return False
    try:
        artifact = load_glb_artifact(path)
    except (OSError, ValueError, json.JSONDecodeError, UnicodeDecodeError, struct.error):
        return False
    return isinstance(getattr(artifact, "document", None), dict)


def _output_kind(key: str) -> str:
    if key == "glb":
        return "glb"
    if key in {"blend", "pptx", "sheet_pdf"}:
        return "other"
    return "png"


def collect_output_evidence(job: Mapping[str, Any]) -> tuple[dict[str, Any], list[dict[str, str]]]:
    outputs = job.get("outputs") if isinstance(job.get("outputs"), Mapping) else {}
    evidence: dict[str, Any] = {}
    warnings: list[dict[str, str]] = []

    def record(key: str, path: Path, *, required: bool, kind: str) -> None:
        if kind == "png":
            ok = _png_structurally_ok(path)
            required_error = f"必需输出 {key} 不是可解码 PNG"
        elif kind == "glb":
            ok = _glb_structurally_ok(path)
            required_error = f"必需输出 {key} 不是可解析 GLB"
        else:
            ok = _regular_file(path)
            required_error = f"必需输出 {key} 缺失或不是普通文件"
        if required:
            if not ok:
                _fail(required_error, cause=f"outputs.{key}")
            evidence[key] = {
                "path": str(path),
                "sha256": _sha256_file(path),
                "bytes": int(_lstat(path).st_size),
            }
            return
        if not path.exists() and not _is_link(_lstat(path)):
            warnings.append({"key": key, "cause": "optional_missing"})
            return
        if not ok:
            warnings.append({"key": key, "cause": "optional_invalid"})
            return
        evidence[key] = {
            "path": str(path),
            "sha256": _sha256_file(path),
            "bytes": int(_lstat(path).st_size),
            "optional": True,
        }

    for key in REQUIRED_STILL_KEYS:
        raw = outputs.get(key)
        if not str(raw or "").strip():
            _fail(f"缺少必需输出 {key}", cause=f"outputs.{key}")
        record(key, Path(str(raw)), required=True, kind=_output_kind(key))
    for key in REQUIRED_CARD_KEYS:
        raw = outputs.get(key)
        if not str(raw or "").strip():
            _fail(f"缺少核对卡 {key}", cause=f"outputs.{key}")
        record(key, Path(str(raw)), required=True, kind="png")
    blend = outputs.get("blend")
    if str(blend or "").strip():
        record("blend", Path(str(blend)), required=True, kind="other")
    for key in OPTIONAL_RENDERER_OUTPUT_KEYS:
        if key in REQUIRED_CARD_KEYS or key in {"pptx", "sheet_pdf"}:
            continue
        raw = outputs.get(key)
        if not str(raw or "").strip():
            continue
        record(key, Path(str(raw)), required=False, kind=_output_kind(key))
    return evidence, warnings


def _result_base(
    *,
    action: str,
    mode: str,
    source_sha: str,
    source_plan: Mapping[str, Any],
    asset_sha: Mapping[str, str],
    candidate_plan_identity: str,
    candidate_identity: str,
    studio_adjustment: Mapping[str, float] | None,
    candidate_dir: Path | None,
    status: str,
) -> dict[str, Any]:
    identity = source_plan["identity"]
    return {
        "ok": True,
        "schema": RESULT_SCHEMA,
        "action": action,
        "mode": mode,
        "source_identity": {
            "resolved_job_sha256": source_sha,
            "plan_identity": source_plan["fingerprint_token"],
            "render_contract_hash": identity["render_contract_hash"],
            "render_profile_id": identity["render_profile_id"],
            "assets": dict(asset_sha),
        },
        "candidate_plan_identity": candidate_plan_identity,
        "candidate_identity": candidate_identity,
        "studio_adjustment": dict(studio_adjustment) if studio_adjustment else None,
        "candidate_dir": str(candidate_dir) if candidate_dir is not None else None,
        "execution": {"status": status, "nonce": None},
        "outputs": {},
        "optional_warnings": [],
        "quality": dict(QUALITY_UNWIRED),
    }


def _refresh_source(
    request: Mapping[str, Any],
) -> tuple[bytes, dict[str, Any], Path, dict[str, Any], dict[str, str]]:
    job_root = request["job_root"]
    raw, parsed, resolved_path = read_source_job(job_root)
    bound = bind_source_job(parsed, job_root, resolved_path)
    assets = verify_source_bindings(
        job_root=job_root,
        raw=raw,
        job=bound,
        expected_source_sha256=request["expected_source_sha256"],
        expected_asset_sha256=request["expected_asset_sha256"],
    )
    plan = plan_for_mode(bound, request["mode"])
    return raw, bound, resolved_path, plan, assets


def run_request(payload: Mapping[str, Any]) -> dict[str, Any]:
    request = parse_request(payload)
    action = request["action"]
    _emit("validate")
    roots = _configured_roots(request["job_root"])
    _assert_trusted_ancestors(request["job_root"], roots, must_exist=True)
    raw, bound, _resolved_path, plan, assets = _refresh_source(request)
    source_sha = _sha256_bytes(raw)
    cand_id = candidate_identity_sha(
        source_plan_identity=plan["fingerprint_token"],
        mode=request["mode"],
        studio_adjustment=request["studio_adjustment"],
    )
    result = _result_base(
        action=action,
        mode=request["mode"],
        source_sha=source_sha,
        source_plan=plan,
        asset_sha=assets,
        candidate_plan_identity=plan["fingerprint_token"],
        candidate_identity=cand_id,
        studio_adjustment=request["studio_adjustment"],
        candidate_dir=request["candidate_dir"],
        status="validated",
    )
    if action == "validate":
        return result

    candidate_dir = request["candidate_dir"]
    assert candidate_dir is not None
    if action == "render-candidate":
        blender = request["blender_executable"]
        assert blender is not None
        if not blender.is_file() or _is_link(_lstat(blender)):
            _fail(
                f"找不到Blender：{blender}",
                code="packaging_failed",
                cause="missing_blender",
                fix="缺 Blender 必须诚实失败，不能默认成功",
            )
    assert_candidate_isolated(
        job_root=request["job_root"],
        candidate_dir=candidate_dir,
        source_job=bound,
    )
    _emit("prepare")
    mkdir_exclusive(candidate_dir)
    remapped = prepare_candidate_job(
        source_job=bound,
        plan=plan,
        candidate_dir=candidate_dir,
        studio_adjustment=request["studio_adjustment"],
        expected_asset_sha256=assets,
    )
    packaging_pipeline.save_json(Path(remapped["resolved_job_path"]), remapped)
    disk_candidate = packaging_pipeline.load_json(Path(remapped["resolved_job_path"]))
    try:
        bound_plan = persistable_plan_from_bound_job(disk_candidate)
        blender_execution_plan(
            disk_candidate,
            remapped,
            resolved_job_path=remapped["resolved_job_path"],
            asset_project_dir=candidate_dir,
        )
    except RenderContractError as error:
        raise _from_contract(error) from error
    if bound_plan["fingerprint_token"] != plan["fingerprint_token"]:
        _fail("候选 persistable plan 与源计划转换不一致", cause="candidate_plan_drift")
    result["candidate_plan_identity"] = bound_plan["fingerprint_token"]
    result["execution"]["status"] = "prepared"
    if action == "prepare":
        return result

    blender = request["blender_executable"]
    assert blender is not None
    _raw_again, bound_again, _resolved_again, plan_again, _assets_again = _refresh_source(request)
    if _sha256_bytes(_raw_again) != source_sha:
        _fail("启动前源合同身份已变化", cause="source_changed_after_validate")
    if plan_again["fingerprint_token"] != plan["fingerprint_token"]:
        _fail("启动前源计划身份已变化", cause="plan_changed_after_validate")
    for face in SEMANTIC_FACES:
        path = Path(str(bound_again["assets"][face]))
        if _sha256_file(path) != assets[face]:
            _fail("启动前六面资产身份已变化", cause=f"asset_changed_{face}")
    _emit("blender")
    nonce_holder: list[str] = []
    try:
        rendered = packaging_pipeline.run_blender_candidate(
            remapped,
            blender,
            asset_project_dir=candidate_dir,
            studio_adjustment=request["studio_adjustment"],
            verified_nonce_holder=nonce_holder,
        )
    except packaging_pipeline.PipelineError as error:
        raise _from_pipeline(error) from error
    if (
        len(nonce_holder) != 1
        or not isinstance(nonce_holder[0], str)
        or not nonce_holder[0].strip()
    ):
        _fail(
            "本轮已验证执行 nonce 缺失",
            cause="execution_nonce_missing",
            fix="只接受 run_blender_job 本轮验证成功的 nonce，不能从旧文件或自报字段抄回",
        )
    verified_nonce = nonce_holder[0]
    evidence, warnings = collect_output_evidence(rendered)
    log_path = Path(str(rendered["project_dir"])) / "blender.log"
    result["outputs"] = evidence
    result["optional_warnings"] = warnings
    result["execution"] = {
        "status": "rendered",
        "nonce": verified_nonce,
        "blender_log": str(log_path) if log_path.is_file() else None,
        "elapsed_s": rendered.get("blender_process_elapsed_s"),
    }
    return result


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    # Transport ownership tag only: never grants access or changes render identity.
    if len(args) == 3 and args[1] == "--execution-id" and re.fullmatch(
        r"[a-zA-Z0-9_-]{1,96}:[a-zA-Z0-9_-]{1,96}:[a-f0-9]{32}", args[2]
    ):
        args = args[:1]
    if not args or args[0] in {"-h", "--help"}:
        print(
            "usage: render_generation.py REQUEST.json|-\n"
            "actions: validate | prepare | render-candidate",
            file=sys.stderr,
        )
        return 2 if not args else 0
    if len(args) != 1:
        _problem("只接受一个请求文件", cause="cli_arity", fix="传入单一 REQUEST.json")
        print(
            json.dumps(
                RenderGenerationError("只接受一个请求文件").as_dict(),
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 2
    try:
        # Node sends one bounded request over stdin; no request file in source/ready.
        if args[0] == "-":
            raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        else:
            with Path(args[0]).expanduser().open("rb") as handle:
                raw = handle.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise RenderGenerationError("请求超过 64 KiB", cause="request_budget")
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise RenderGenerationError("请求必须是 JSON 对象")
        result = run_request(payload)
    except RenderGenerationError as error:
        _problem(str(error), cause=error.cause or error.code, fix=error.fix or "检查请求与源 fixture")
        print(json.dumps(error.as_dict(), ensure_ascii=False, separators=(",", ":")))
        return 2
    except packaging_pipeline.PipelineError as error:
        wrapped = _from_pipeline(error)
        _problem(str(wrapped), cause=wrapped.cause, fix=wrapped.fix)
        print(json.dumps(wrapped.as_dict(), ensure_ascii=False, separators=(",", ":")))
        return 2
    except RenderContractError as error:
        wrapped = _from_contract(error)
        _problem(str(wrapped), cause=wrapped.cause, fix=wrapped.fix)
        print(json.dumps(wrapped.as_dict(), ensure_ascii=False, separators=(",", ":")))
        return 2
    except Exception as error:
        wrapped = RenderGenerationError(str(error)[:80], cause="internal")
        _problem(str(wrapped), cause="internal", fix="不要把测试 hook 当成生产能力")
        print(json.dumps(wrapped.as_dict(), ensure_ascii=False, separators=(",", ":")))
        return 2
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
