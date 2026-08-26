"""Versioned input boundary for semantic packaging structures.

The first production-safe adapter is an explicit JSON sidecar.  Merely finding
an AI/PDF layer or stroke colour is deliberately not an adapter: legacy files
without approved semantics remain review-required.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
from typing import Any

from .model import StructureContractError, load_structure


MAX_STRUCTURE_BYTES = 25 * 1024 * 1024


class StructureAdapterError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": str(self), "details": self.details}


@dataclass(frozen=True)
class AdaptationResult:
    status: str
    code: str | None = None
    message: str | None = None
    structure: dict[str, Any] | None = None
    sidecar_path: str | None = None

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"status": self.status}
        if self.code:
            result["code"] = self.code
        if self.message:
            result["message"] = self.message
        if self.structure is not None:
            result["structure"] = self.structure
        if self.sidecar_path:
            result["sidecar_path"] = self.sidecar_path
        return result


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def sidecar_candidates(source: Path) -> list[Path]:
    values = [
        source.with_name(source.name + ".structure.json"),
        source.with_suffix(".structure.json"),
    ]
    result: list[Path] = []
    seen: set[Path] = set()
    for value in values:
        resolved = value.resolve()
        if resolved not in seen:
            seen.add(resolved)
            result.append(resolved)
    return result


def adapt_structure(source: Path | str, *, sidecar: Path | str | None = None) -> AdaptationResult:
    source_path = Path(source).expanduser().resolve()
    if not source_path.is_file():
        raise StructureAdapterError(
            "packaging_source_missing",
            f"包装源文件不存在：{source_path}",
            details={"source": str(source_path)},
        )
    if sidecar is not None:
        structure_path = Path(sidecar).expanduser().resolve()
        if not structure_path.is_file():
            raise StructureAdapterError(
                "structure_sidecar_missing",
                f"指定的结构 sidecar 不存在：{structure_path}",
                details={"sidecar": str(structure_path)},
            )
    else:
        structure_path = next((path for path in sidecar_candidates(source_path) if path.is_file()), None)
        if structure_path is None:
            return AdaptationResult(
                status="review_required",
                code="structure_semantics_missing",
                message="稿件没有已批准的包装结构语义，请导出结构 sidecar 或人工确认。",
            )
    if structure_path.stat().st_size > MAX_STRUCTURE_BYTES:
        return AdaptationResult(
            status="unsupported",
            code="structure_limit_exceeded",
            message="包装结构 sidecar 超过 25 MB 上限。",
            sidecar_path=str(structure_path),
        )
    try:
        structure = load_structure(structure_path)
    except (OSError, ValueError, StructureContractError) as error:
        code = getattr(error, "code", "structure_contract_invalid")
        status = "unsupported" if code == "structure_schema_unsupported" else "review_required"
        return AdaptationResult(
            status=status,
            code=code,
            message=f"包装结构 sidecar 无法使用：{error}",
            sidecar_path=str(structure_path),
        )
    actual_hash = sha256_file(source_path)
    if structure["source"]["sha256"] != actual_hash:
        return AdaptationResult(
            status="review_required",
            code="structure_source_mismatch",
            message="结构 sidecar 对应的源稿已经变化，请重新导出或确认。",
            sidecar_path=str(structure_path),
        )
    return AdaptationResult(
        status="adapted",
        structure=structure,
        sidecar_path=str(structure_path),
    )
