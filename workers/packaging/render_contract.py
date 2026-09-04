"""Strict, versioned render semantics for the existing packaging pipeline.

This module is deliberately the only reader of ``render-profiles.v1.json``.
It resolves accepted structure facts into a canonical render spec without
calling Blender or changing product output.  Later pipeline slices consume the
spec; they must not recreate profile defaults independently.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any, Mapping


REGISTRY_SCHEMA = "packaging-render-profile-registry/1"
RENDER_SPEC_SCHEMA = "packaging-render-spec/1"
RESOLVED_STRUCTURE_SCHEMA = "resolved-packaging-job/3"
STRUCTURE_SCHEMA = "packaging-structure/1"
DEFAULT_REGISTRY_PATH = (
    Path(__file__).resolve().parent / "profiles" / "render-profiles.v1.json"
)

SEMANTIC_FACES = ("front", "right", "back", "left", "top", "bottom")
RENDER_FAMILIES = ("rectangular_carton_v1", "pouch_thin_card_v1")
VIEW_IDS = ("front_right", "back_left")

MAX_REGISTRY_BYTES = 2 * 1024 * 1024
MAX_DIMENSION_MM = 10_000.0
MAX_MASTER_EDGE_PX = 12_000
MAX_MASTER_PIXELS = 64_000_000
MAX_FACE_PIXELS = 32_000_000
MAX_CARD_EDGE_PX = 1_440

_IDENTIFIER = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_STRUCTURE_FAMILY_MAP = {
    "carton": "rectangular_carton_v1",
    "rectangular_carton_v1": "rectangular_carton_v1",
    "pouch": "pouch_thin_card_v1",
    "pouch_thin_card_v1": "pouch_thin_card_v1",
}


class RenderContractError(ValueError):
    """Stable render-contract failure for pipeline and product-state mapping."""

    def __init__(
        self, code: str, message: str, *, details: Mapping[str, Any] | None = None
    ):
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": str(self), "details": self.details}


def _fail(code: str, message: str, **details: Any) -> None:
    raise RenderContractError(code, message, details=details)


def _invalid(message: str, *, field: str, **details: Any) -> None:
    _fail("render_contract_invalid", message, field=field, **details)


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        _invalid(f"{label} 必须是对象", field=label)
    return value


def _list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        _invalid(f"{label} 必须是数组", field=label)
    return value


def _known_keys(value: Mapping[str, Any], allowed: set[str], label: str) -> None:
    non_text_types = sorted(
        {type(key).__name__ for key in value if not isinstance(key, str)}
    )
    if non_text_types:
        _invalid(
            f"{label} 的字段名必须是文本",
            field=label,
            key_types=non_text_types,
        )
    unknown = sorted(set(value) - allowed)
    if unknown:
        _invalid(
            f"{label} 含未知字段：{','.join(unknown)}",
            field=label,
            unknown=unknown,
        )


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        _invalid(f"{label} 必须是稳定的小写标识", field=label)
    return value


def _text(value: Any, label: str, *, allowed: set[str] | None = None) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 128
        or any(ch in value for ch in "\r\n\t")
    ):
        _invalid(f"{label} 必须是 1–128 字符文本", field=label)
    if allowed is not None and value not in allowed:
        _invalid(f"{label} 不受支持：{value}", field=label, value=value)
    return value


def _boolean(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        _invalid(f"{label} 必须是布尔值", field=label)
    return value


def _number(
    value: Any,
    label: str,
    *,
    lower: float | None = None,
    upper: float | None = None,
) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
    ):
        _invalid(f"{label} 必须是有限数值", field=label)
    result = float(value)
    if lower is not None and result < lower:
        _invalid(f"{label} 不能小于 {lower}", field=label, value=result)
    if upper is not None and result > upper:
        _invalid(f"{label} 不能大于 {upper}", field=label, value=result)
    result = round(result, 6)
    return 0.0 if result == -0.0 else result


def _integer(value: Any, label: str, *, lower: int, upper: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < lower
        or value > upper
    ):
        _invalid(f"{label} 必须是 {lower}–{upper} 的整数", field=label, value=value)
    return value


def _hash_identity(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _SHA256.fullmatch(value):
        _invalid(f"{label} 必须是 sha256: 加 64 位小写十六进制", field=label)
    return value


def _canonical_bytes(payload: Any) -> bytes:
    try:
        text = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        return text.encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as error:
        _invalid("合同不能规范化为有限 JSON", field="canonical_json", cause=str(error))


def canonical_sha256(payload: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical_bytes(payload)).hexdigest()


def _raw_sha256(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _duplicate_safe_json(raw: bytes, path: Path) -> Any:
    def pairs_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate key: {key}")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        raise ValueError(f"non-finite constant: {value}")

    try:
        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=pairs_hook,
            parse_constant=reject_constant,
        )
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        ValueError,
        RecursionError,
    ) as error:
        _invalid(
            "渲染 profile registry 不是严格 JSON",
            field="registry",
            cause=str(error),
            path=str(path),
        )


def _normalize_renderer(value: Any, label: str) -> dict[str, Any]:
    renderer = _mapping(value, label)
    _known_keys(renderer, {"engine", "minimum_blender_version", "samples"}, label)
    return {
        "engine": _text(
            renderer.get("engine"),
            f"{label}.engine",
            allowed={"BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"},
        ),
        "minimum_blender_version": _text(
            renderer.get("minimum_blender_version"),
            f"{label}.minimum_blender_version",
            allowed={"project-supported"},
        ),
        "samples": _integer(
            renderer.get("samples"), f"{label}.samples", lower=1, upper=4096
        ),
    }


def _normalize_geometry_config(value: Any, label: str, family: str) -> dict[str, Any]:
    geometry = _mapping(value, label)
    _known_keys(
        geometry,
        {
            "substrate_profile",
            "closure_detail",
            "core_bevel_mm",
            "surface_gap_mm",
            "preview_fidelity",
        },
        label,
    )
    preview = _text(
        geometry.get("preview_fidelity"),
        f"{label}.preview_fidelity",
        allowed={"legacy_box", "carton_physical_v1", "thin_card"},
    )
    if family == "pouch_thin_card_v1" and preview != "thin_card":
        _invalid(
            "膜袋兼容 family 必须明确 thin_card", field=f"{label}.preview_fidelity"
        )
    if family == "rectangular_carton_v1" and preview == "thin_card":
        _invalid("矩形纸盒不能声明 thin_card", field=f"{label}.preview_fidelity")
    return {
        "substrate_profile": _text(
            geometry.get("substrate_profile"),
            f"{label}.substrate_profile",
            allowed={"white-card-default-v1"},
        ),
        "closure_detail": _text(
            geometry.get("closure_detail"),
            f"{label}.closure_detail",
            allowed=(
                {"legacy-closed-box-v0", "closed-carton-visual-v1"}
                if family == "rectangular_carton_v1"
                else {"thin-card-preview-v1"}
            ),
        ),
        "core_bevel_mm": _number(
            geometry.get("core_bevel_mm"),
            f"{label}.core_bevel_mm",
            lower=0.0,
            upper=10.0,
        ),
        "surface_gap_mm": _number(
            geometry.get("surface_gap_mm"),
            f"{label}.surface_gap_mm",
            lower=0.0,
            upper=10.0,
        ),
        "preview_fidelity": preview,
    }


def _normalize_geometry_profiles(value: Any, label: str) -> dict[str, dict[str, Any]]:
    geometries = _mapping(value, label)
    if not geometries:
        _invalid(f"{label} 至少声明一个 family", field=label)
    unknown = sorted(set(geometries) - set(RENDER_FAMILIES))
    if unknown:
        _invalid(
            f"{label} 含未知 family：{','.join(unknown)}", field=label, unknown=unknown
        )
    return {
        family: _normalize_geometry_config(
            geometries[family], f"{label}.{family}", family
        )
        for family in RENDER_FAMILIES
        if family in geometries
    }


def _normalize_rgba(value: Any, label: str) -> list[float]:
    channels = _list(value, label)
    if len(channels) != 4:
        _invalid(f"{label} 必须有四个通道", field=label)
    result = [
        _number(channel, f"{label}[{index}]", lower=0.0, upper=1.0)
        for index, channel in enumerate(channels)
    ]
    if result[3] != 1.0:
        _invalid(f"{label} 的 Alpha 必须为 1", field=f"{label}[3]")
    return result


def _normalize_material(value: Any, label: str) -> dict[str, Any]:
    material = _mapping(value, label)
    _known_keys(
        material,
        {
            "substrate_profile",
            "print_layer",
            "finish_profile",
            "spot_finish_mask",
            "substrate_rgba",
            "roughness",
            "specular_ior_level",
        },
        label,
    )
    if material.get("spot_finish_mask") is not None:
        _fail(
            "render_finish_mask_unsupported",
            "局部工艺必须绑定后续切片提供的独立语义 mask",
            field=f"{label}.spot_finish_mask",
        )
    return {
        "substrate_profile": _text(
            material.get("substrate_profile"),
            f"{label}.substrate_profile",
            allowed={"white-card-default-v1"},
        ),
        "print_layer": _text(
            material.get("print_layer"),
            f"{label}.print_layer",
            allowed={"process-ink-v1"},
        ),
        "finish_profile": _text(
            material.get("finish_profile"),
            f"{label}.finish_profile",
            allowed={"none", "overall-matte-lamination-v1", "overall-gloss-varnish-v1"},
        ),
        "spot_finish_mask": None,
        "substrate_rgba": _normalize_rgba(
            material.get("substrate_rgba"), f"{label}.substrate_rgba"
        ),
        "roughness": _number(
            material.get("roughness"), f"{label}.roughness", lower=0.0, upper=1.0
        ),
        "specular_ior_level": _number(
            material.get("specular_ior_level"),
            f"{label}.specular_ior_level",
            lower=0.0,
            upper=1.0,
        ),
    }


def _normalize_resolution(value: Any, label: str) -> list[int]:
    dimensions = _list(value, label)
    if len(dimensions) != 2:
        _invalid(f"{label} 必须是 [width,height]", field=label)
    result = [
        _integer(dimensions[0], f"{label}[0]", lower=64, upper=MAX_MASTER_EDGE_PX),
        _integer(dimensions[1], f"{label}[1]", lower=64, upper=MAX_MASTER_EDGE_PX),
    ]
    if result[0] * result[1] > MAX_MASTER_PIXELS:
        _invalid(f"{label} 超过主图像素预算", field=label, pixels=result[0] * result[1])
    return result


def _normalize_views(value: Any, label: str) -> list[str]:
    views = _list(value, label)
    if tuple(views) != VIEW_IDS:
        _invalid(f"{label} 必须保持 front_right/back_left", field=label)
    return list(VIEW_IDS)


def _normalize_studio(value: Any, label: str) -> dict[str, Any]:
    studio = _mapping(value, label)
    _known_keys(
        studio,
        {
            "profile",
            "projection",
            "master_resolution_px",
            "views",
            "camera_mode",
            "camera_ortho_scale_mm",
            "front_rotation_deg",
            "back_rotation_deg",
            "world_strength",
            "light_energy_scale",
            "exact_white_background",
        },
        label,
    )
    camera_mode = _text(
        studio.get("camera_mode"),
        f"{label}.camera_mode",
        allowed={"legacy-pinned", "dimension-fit"},
    )
    raw_scale = studio.get("camera_ortho_scale_mm")
    if camera_mode == "legacy-pinned":
        camera_scale = _number(
            raw_scale, f"{label}.camera_ortho_scale_mm", lower=1.0, upper=20_000.0
        )
    elif raw_scale is not None:
        _invalid(
            "dimension-fit 相机不能携带固定 ortho scale",
            field=f"{label}.camera_ortho_scale_mm",
        )
    else:
        camera_scale = None
    return {
        "profile": _text(
            studio.get("profile"),
            f"{label}.profile",
            allowed={"legacy-fixed-three-area-v0", "three-softbox-no-hdri-v1"},
        ),
        "projection": _text(
            studio.get("projection"), f"{label}.projection", allowed={"ORTHOGRAPHIC"}
        ),
        "master_resolution_px": _normalize_resolution(
            studio.get("master_resolution_px"),
            f"{label}.master_resolution_px",
        ),
        "views": _normalize_views(studio.get("views"), f"{label}.views"),
        "camera_mode": camera_mode,
        "camera_ortho_scale_mm": camera_scale,
        "front_rotation_deg": _number(
            studio.get("front_rotation_deg"),
            f"{label}.front_rotation_deg",
            lower=-360.0,
            upper=360.0,
        ),
        "back_rotation_deg": _number(
            studio.get("back_rotation_deg"),
            f"{label}.back_rotation_deg",
            lower=-360.0,
            upper=360.0,
        ),
        "world_strength": _number(
            studio.get("world_strength"),
            f"{label}.world_strength",
            lower=0.0,
            upper=10.0,
        ),
        "light_energy_scale": _number(
            studio.get("light_energy_scale"),
            f"{label}.light_energy_scale",
            lower=0.0,
            upper=20.0,
        ),
        "exact_white_background": _boolean(
            studio.get("exact_white_background"),
            f"{label}.exact_white_background",
        ),
    }


def _normalize_color(value: Any, label: str) -> dict[str, Any]:
    color = _mapping(value, label)
    _known_keys(
        color,
        {"view_transform", "look", "exposure", "png_compression", "color_depth_bits"},
        label,
    )
    return {
        "view_transform": _text(
            color.get("view_transform"),
            f"{label}.view_transform",
            allowed={"Standard", "Khronos PBR Neutral", "AgX"},
        ),
        "look": _text(color.get("look"), f"{label}.look", allowed={"None"}),
        "exposure": _number(
            color.get("exposure"), f"{label}.exposure", lower=-10.0, upper=10.0
        ),
        "png_compression": _integer(
            color.get("png_compression"),
            f"{label}.png_compression",
            lower=0,
            upper=100,
        ),
        "color_depth_bits": _integer(
            color.get("color_depth_bits"),
            f"{label}.color_depth_bits",
            lower=8,
            upper=16,
        ),
    }


def _normalize_sampling(value: Any, label: str) -> dict[str, Any]:
    sampling = _mapping(value, label)
    _known_keys(
        sampling,
        {
            "strategy",
            "minimum_face_pixels_per_mm",
            "maximum_face_pixels_per_mm",
            "maximum_face_pixels",
            "oversample_ratio",
            "legacy_raster_width_px",
        },
        label,
    )
    minimum = _number(
        sampling.get("minimum_face_pixels_per_mm"),
        f"{label}.minimum_face_pixels_per_mm",
        lower=1.0,
        upper=64.0,
    )
    maximum = _number(
        sampling.get("maximum_face_pixels_per_mm"),
        f"{label}.maximum_face_pixels_per_mm",
        lower=1.0,
        upper=64.0,
    )
    if minimum > maximum:
        _invalid(
            "最小面采样不能高于最大面采样",
            field=label,
            minimum=minimum,
            maximum=maximum,
        )
    return {
        "strategy": _text(
            sampling.get("strategy"),
            f"{label}.strategy",
            allowed={"minimum-floor-v1"},
        ),
        "minimum_face_pixels_per_mm": minimum,
        "maximum_face_pixels_per_mm": maximum,
        "maximum_face_pixels": _integer(
            sampling.get("maximum_face_pixels"),
            f"{label}.maximum_face_pixels",
            lower=1,
            upper=MAX_FACE_PIXELS,
        ),
        "oversample_ratio": _number(
            sampling.get("oversample_ratio"),
            f"{label}.oversample_ratio",
            lower=1.0,
            upper=4.0,
        ),
        "legacy_raster_width_px": _integer(
            sampling.get("legacy_raster_width_px"),
            f"{label}.legacy_raster_width_px",
            lower=64,
            upper=100_000,
        ),
    }


def _normalize_outputs(value: Any, label: str) -> dict[str, Any]:
    outputs = _mapping(value, label)
    _known_keys(
        outputs,
        {
            "product_rgba",
            "ground_pass",
            "white_set_pass",
            "review_card_max_edge_px",
            "preserve_legacy_keys",
        },
        label,
    )
    product = _boolean(outputs.get("product_rgba"), f"{label}.product_rgba")
    preserve = _boolean(
        outputs.get("preserve_legacy_keys"), f"{label}.preserve_legacy_keys"
    )
    if not product or not preserve:
        _invalid("当前输出合同必须保留产品 RGBA 与既有 key", field=label)
    return {
        "product_rgba": True,
        "ground_pass": _text(
            outputs.get("ground_pass"),
            f"{label}.ground_pass",
            allowed={"required", "optional", "disabled"},
        ),
        "white_set_pass": _text(
            outputs.get("white_set_pass"),
            f"{label}.white_set_pass",
            allowed={"required", "optional", "disabled"},
        ),
        "review_card_max_edge_px": _integer(
            outputs.get("review_card_max_edge_px"),
            f"{label}.review_card_max_edge_px",
            lower=64,
            upper=MAX_CARD_EDGE_PX,
        ),
        "preserve_legacy_keys": True,
    }


def _normalize_profile(
    value: Any, label: str, *, verify_declared: bool
) -> dict[str, Any]:
    profile = _mapping(value, label)
    allowed = {
        "id",
        "declared_sha256",
        "renderer",
        "geometry",
        "material",
        "studio",
        "color",
        "sampling",
        "outputs",
    }
    # ``profile_sha256`` is derived loader output.  It is accepted only when
    # normalizing that output again for hashing; authors cannot put a second
    # hash identity into the registry source.
    if not verify_declared:
        allowed.add("profile_sha256")
    _known_keys(
        profile,
        allowed,
        label,
    )
    profile_id = _identifier(profile.get("id"), f"{label}.id")
    payload = {
        "id": profile_id,
        "renderer": _normalize_renderer(profile.get("renderer"), f"{label}.renderer"),
        "geometry": _normalize_geometry_profiles(
            profile.get("geometry"), f"{label}.geometry"
        ),
        "material": _normalize_material(profile.get("material"), f"{label}.material"),
        "studio": _normalize_studio(profile.get("studio"), f"{label}.studio"),
        "color": _normalize_color(profile.get("color"), f"{label}.color"),
        "sampling": _normalize_sampling(profile.get("sampling"), f"{label}.sampling"),
        "outputs": _normalize_outputs(profile.get("outputs"), f"{label}.outputs"),
    }
    expected = canonical_sha256(payload)
    if verify_declared:
        declared = _hash_identity(
            profile.get("declared_sha256"), f"{label}.declared_sha256"
        )
        if declared != expected:
            _invalid(
                f"{profile_id} 的声明 hash 与规范化内容不一致",
                field=f"{label}.declared_sha256",
                profile_id=profile_id,
                expected=expected,
                actual=declared,
            )
    return {**payload, "declared_sha256": expected, "profile_sha256": expected}


def profile_declared_sha256(profile: Mapping[str, Any]) -> str:
    raw = dict(profile)
    raw.pop("profile_sha256", None)
    return _normalize_profile(raw, "profile", verify_declared=False)["profile_sha256"]


def load_profile_registry(path: Path | str = DEFAULT_REGISTRY_PATH) -> dict[str, Any]:
    target = Path(path).expanduser().resolve()
    try:
        size = target.stat().st_size
    except OSError as error:
        _invalid(
            "找不到渲染 profile registry",
            field="registry",
            path=str(target),
            cause=str(error),
        )
    if size > MAX_REGISTRY_BYTES:
        _invalid(
            "渲染 profile registry 超过大小上限",
            field="registry",
            path=str(target),
            bytes=size,
        )
    try:
        raw = target.read_bytes()
    except OSError as error:
        _invalid(
            "无法读取渲染 profile registry",
            field="registry",
            path=str(target),
            cause=str(error),
        )
    if len(raw) > MAX_REGISTRY_BYTES:
        _invalid(
            "渲染 profile registry 超过大小上限",
            field="registry",
            path=str(target),
            bytes=len(raw),
        )
    payload = _mapping(_duplicate_safe_json(raw, target), "registry")
    _known_keys(payload, {"schema", "profiles"}, "registry")
    if payload.get("schema") != REGISTRY_SCHEMA:
        _invalid(
            "渲染 profile registry schema 不受支持",
            field="registry.schema",
            value=payload.get("schema"),
        )
    raw_profiles = _list(payload.get("profiles"), "registry.profiles")
    if not raw_profiles or len(raw_profiles) > 64:
        _invalid(
            "registry.profiles 必须有 1–64 项",
            field="registry.profiles",
            count=len(raw_profiles),
        )
    profiles: dict[str, dict[str, Any]] = {}
    for index, raw_profile in enumerate(raw_profiles):
        profile = _normalize_profile(
            raw_profile, f"registry.profiles[{index}]", verify_declared=True
        )
        profile_id = profile["id"]
        if profile_id in profiles:
            _invalid(
                "registry profile ID 重复",
                field="registry.profiles",
                profile_id=profile_id,
            )
        profiles[profile_id] = profile
    return {
        "schema": REGISTRY_SCHEMA,
        "registry_sha256": _raw_sha256(raw),
        "profiles": profiles,
    }


def validate_registry_update(
    previous_path: Path | str,
    candidate_path: Path | str,
) -> dict[str, Any]:
    previous = load_profile_registry(previous_path)
    candidate = load_profile_registry(candidate_path)
    for profile_id, old_profile in previous["profiles"].items():
        new_profile = candidate["profiles"].get(profile_id)
        if new_profile is None:
            _invalid(
                "已登记 profile 不得删除或改名",
                field="registry.profiles",
                profile_id=profile_id,
            )
        if new_profile["profile_sha256"] != old_profile["profile_sha256"]:
            _invalid(
                "已登记 profile 不得原位改变视觉语义",
                field="registry.profiles",
                profile_id=profile_id,
                previous=old_profile["profile_sha256"],
                candidate=new_profile["profile_sha256"],
            )
    return candidate


def render_capability_matrix(
    path: Path | str = DEFAULT_REGISTRY_PATH,
) -> dict[str, list[dict[str, Any]]]:
    registry = load_profile_registry(path)
    matrix: dict[str, list[dict[str, Any]]] = {}
    for profile_id, profile in registry["profiles"].items():
        for family, geometry in profile["geometry"].items():
            matrix.setdefault(family, []).append(
                {
                    "profile_id": profile_id,
                    "substrate_profile": profile["material"]["substrate_profile"],
                    "finish_profile": profile["material"]["finish_profile"],
                    "studio_profile": profile["studio"]["profile"],
                    "preview_fidelity": geometry["preview_fidelity"],
                }
            )
    return {family: matrix[family] for family in RENDER_FAMILIES if family in matrix}


def _normalize_dimensions(value: Any, label: str) -> dict[str, float]:
    dimensions = _mapping(value, label)
    _known_keys(dimensions, {"width", "depth", "height"}, label)
    return {
        key: _number(
            dimensions.get(key), f"{label}.{key}", lower=1e-6, upper=MAX_DIMENSION_MM
        )
        for key in ("width", "depth", "height")
    }


def _normalize_structure_job(
    structure_job: Mapping[str, Any],
) -> tuple[str, dict[str, float], str]:
    structure = _mapping(structure_job, "structure_job")
    if structure.get("schema") != RESOLVED_STRUCTURE_SCHEMA:
        _invalid(
            "structure_job 不是受支持的 ResolvedPackagingJob",
            field="structure_job.schema",
        )
    if structure.get("structure_schema") != STRUCTURE_SCHEMA:
        _invalid(
            "structure_job 的结构 schema 不受支持",
            field="structure_job.structure_schema",
        )
    validation = _mapping(structure.get("validation"), "structure_job.validation")
    if validation.get("status") != "accepted":
        _invalid(
            "只有 accepted 结构才能解析渲染合同",
            field="structure_job.validation.status",
        )
    structure_hash = _hash_identity(
        structure.get("structure_hash"), "structure_job.structure_hash"
    )
    dimensions = _normalize_dimensions(
        structure.get("dimensions_mm"), "structure_job.dimensions_mm"
    )

    declared_family = structure.get("packaging_family")
    if declared_family is None:
        faces = structure.get("faces")
        if not isinstance(faces, Mapping) or set(faces) != set(SEMANTIC_FACES):
            _fail(
                "render_family_unsupported",
                "旧结构缺少可证明的完整六面，不能默认套矩形盒",
                family=None,
            )
        family = "rectangular_carton_v1"
    else:
        family = (
            _STRUCTURE_FAMILY_MAP.get(declared_family)
            if isinstance(declared_family, str)
            else None
        )
        if family is None:
            _fail(
                "render_family_unsupported",
                "结构 family 尚未登记渲染能力",
                family=declared_family,
            )
        faces = structure.get("faces")
        if not isinstance(faces, Mapping) or set(faces) != set(SEMANTIC_FACES):
            _fail(
                "render_family_unsupported",
                "结构 family 缺少完整六面合同",
                family=declared_family,
            )
    if family == "pouch_thin_card_v1" and dimensions["depth"] != 3.0:
        _fail(
            "render_family_unsupported",
            "pouch_thin_card_v1 只允许现有 3 mm 薄盒预览",
            family=family,
            depth_mm=dimensions["depth"],
        )
    return family, dimensions, structure_hash


def _resolved_output_contract(
    profile_outputs: Mapping[str, Any], output_request: Mapping[str, Any] | None
) -> dict[str, Any]:
    request = _mapping(
        {} if output_request is None else output_request, "output_request"
    )
    _known_keys(request, {"ground_pass", "white_set_pass"}, "output_request")
    resolved = dict(profile_outputs)
    for key in ("ground_pass", "white_set_pass"):
        requested = request.get(key, profile_outputs[key] != "disabled")
        requested = _boolean(requested, f"output_request.{key}")
        capability = profile_outputs[key]
        if requested and capability == "disabled":
            _fail(
                "render_profile_unsupported",
                "所选 profile 不支持请求的输出 pass",
                output=key,
            )
        if not requested and capability == "required":
            _invalid("必需输出 pass 不能关闭", field=f"output_request.{key}")
        resolved[key] = capability if requested else "disabled"
    return resolved


def _spec_geometry(value: Any, profile: Mapping[str, Any]) -> dict[str, Any]:
    geometry = _mapping(value, "spec.geometry")
    _known_keys(
        geometry,
        {
            "family",
            "structure_hash",
            "outer_dimensions_mm",
            "substrate_profile",
            "closure_detail",
            "core_bevel_mm",
            "surface_gap_mm",
            "preview_fidelity",
        },
        "spec.geometry",
    )
    family = _text(
        geometry.get("family"), "spec.geometry.family", allowed=set(RENDER_FAMILIES)
    )
    expected = profile["geometry"].get(family)
    if expected is None:
        _fail(
            "render_profile_unsupported",
            "所选 profile 与结构 family 不兼容",
            profile_id=profile["id"],
            family=family,
        )
    fixed = _normalize_geometry_config(
        {key: geometry.get(key) for key in expected},
        "spec.geometry",
        family,
    )
    if fixed != expected:
        _invalid("spec.geometry 与已登记 profile 不一致", field="spec.geometry")
    return {
        "family": family,
        "structure_hash": _hash_identity(
            geometry.get("structure_hash"), "spec.geometry.structure_hash"
        ),
        "outer_dimensions_mm": _normalize_dimensions(
            geometry.get("outer_dimensions_mm"),
            "spec.geometry.outer_dimensions_mm",
        ),
        **fixed,
    }


def _spec_renderer(
    value: Any, registry: Mapping[str, Any]
) -> tuple[dict[str, Any], Mapping[str, Any]]:
    renderer = _mapping(value, "spec.renderer")
    _known_keys(
        renderer,
        {"engine", "minimum_blender_version", "samples", "profile", "profile_sha256"},
        "spec.renderer",
    )
    profile_id = _identifier(renderer.get("profile"), "spec.renderer.profile")
    profile = registry["profiles"].get(profile_id)
    if profile is None:
        _fail(
            "render_profile_unsupported", "渲染 profile 未登记", profile_id=profile_id
        )
    fixed = _normalize_renderer(
        {
            "engine": renderer.get("engine"),
            "minimum_blender_version": renderer.get("minimum_blender_version"),
            "samples": renderer.get("samples"),
        },
        "spec.renderer",
    )
    if fixed != profile["renderer"]:
        _invalid("spec.renderer 与已登记 profile 不一致", field="spec.renderer")
    profile_hash = _hash_identity(
        renderer.get("profile_sha256"), "spec.renderer.profile_sha256"
    )
    if profile_hash != profile["profile_sha256"]:
        _invalid(
            "spec.renderer.profile_sha256 不匹配", field="spec.renderer.profile_sha256"
        )
    return {**fixed, "profile": profile_id, "profile_sha256": profile_hash}, profile


def _spec_shots(value: Any, profile: Mapping[str, Any]) -> dict[str, Any]:
    shots = _mapping(value, "spec.shots")
    _known_keys(
        shots,
        {
            "projection",
            "master_resolution_px",
            "views",
            "studio_profile",
            "camera_mode",
            "camera_ortho_scale_mm",
            "front_rotation_deg",
            "back_rotation_deg",
            "world_strength",
            "light_energy_scale",
            "exact_white_background",
        },
        "spec.shots",
    )
    as_studio = dict(shots)
    as_studio["profile"] = as_studio.pop("studio_profile", None)
    normalized = _normalize_studio(as_studio, "spec.shots")
    if normalized != profile["studio"]:
        _invalid("spec.shots 与已登记 profile 不一致", field="spec.shots")
    return {"studio_profile": normalized.pop("profile"), **normalized}


def _spec_color(value: Any, profile: Mapping[str, Any]) -> dict[str, Any]:
    color = _normalize_color(value, "spec.color")
    if color != profile["color"]:
        _invalid("spec.color 与已登记 profile 不一致", field="spec.color")
    return color


def _spec_sampling(value: Any, profile: Mapping[str, Any]) -> dict[str, Any]:
    sampling = _mapping(value, "spec.sampling")
    _known_keys(
        sampling,
        {
            "strategy",
            "minimum_face_pixels_per_mm",
            "maximum_face_pixels_per_mm",
            "maximum_face_pixels",
            "oversample_ratio",
            "legacy_raster_width_px",
            "per_face_target_pixels_per_mm",
        },
        "spec.sampling",
    )
    fixed_raw = {key: sampling.get(key) for key in profile["sampling"]}
    fixed = _normalize_sampling(fixed_raw, "spec.sampling")
    if fixed != profile["sampling"]:
        _invalid("spec.sampling 与已登记 profile 不一致", field="spec.sampling")
    targets = _mapping(
        sampling.get("per_face_target_pixels_per_mm"),
        "spec.sampling.per_face_target_pixels_per_mm",
    )
    _known_keys(
        targets, set(SEMANTIC_FACES), "spec.sampling.per_face_target_pixels_per_mm"
    )
    if set(targets) != set(SEMANTIC_FACES):
        _invalid(
            "每个语义面都必须声明目标采样",
            field="spec.sampling.per_face_target_pixels_per_mm",
        )
    normalized_targets = {
        face: _number(
            targets.get(face),
            f"spec.sampling.per_face_target_pixels_per_mm.{face}",
            lower=fixed["minimum_face_pixels_per_mm"],
            upper=fixed["maximum_face_pixels_per_mm"],
        )
        for face in SEMANTIC_FACES
    }
    if fixed["strategy"] == "minimum-floor-v1" and any(
        value != fixed["minimum_face_pixels_per_mm"]
        for value in normalized_targets.values()
    ):
        _invalid(
            "minimum-floor-v1 必须使用 profile 下限",
            field="spec.sampling.per_face_target_pixels_per_mm",
        )
    return {**fixed, "per_face_target_pixels_per_mm": normalized_targets}


def _enforce_texture_budget(
    dimensions: Mapping[str, float],
    sampling: Mapping[str, Any],
) -> None:
    face_axes = {
        "front": ("width", "height"),
        "right": ("depth", "height"),
        "back": ("width", "height"),
        "left": ("depth", "height"),
        "top": ("width", "depth"),
        "bottom": ("width", "depth"),
    }
    allowed = sampling["maximum_face_pixels"]
    targets = sampling["per_face_target_pixels_per_mm"]
    for face in SEMANTIC_FACES:
        horizontal, vertical = face_axes[face]
        ppm = targets[face]
        width_px = max(8, math.ceil(dimensions[horizontal] * ppm))
        height_px = max(8, math.ceil(dimensions[vertical] * ppm))
        required = width_px * height_px
        if required > allowed:
            _fail(
                "render_texture_budget_exceeded",
                "语义面在最低清晰度下仍超过纹理像素预算，禁止静默降采样",
                face=face,
                required_pixels=required,
                allowed_pixels=allowed,
                required_size_px=[width_px, height_px],
                target_pixels_per_mm=ppm,
            )


def _spec_outputs(value: Any, profile: Mapping[str, Any]) -> dict[str, Any]:
    outputs = _normalize_outputs(value, "spec.outputs")
    for key in ("product_rgba", "review_card_max_edge_px", "preserve_legacy_keys"):
        if outputs[key] != profile["outputs"][key]:
            _invalid(
                "spec.outputs 与已登记 profile 不一致", field=f"spec.outputs.{key}"
            )
    for key in ("ground_pass", "white_set_pass"):
        capability = profile["outputs"][key]
        if outputs[key] not in {capability, "disabled"}:
            _invalid(
                "spec.outputs 请求了 profile 未声明的 pass", field=f"spec.outputs.{key}"
            )
        if capability == "required" and outputs[key] == "disabled":
            _invalid("spec.outputs 关闭了必需 pass", field=f"spec.outputs.{key}")
    return outputs


def _semantic_contract_payload(spec: Mapping[str, Any]) -> dict[str, Any]:
    payload = deepcopy(dict(spec))
    payload.pop("registry_sha256", None)
    payload.pop("render_contract_hash", None)
    return payload


def render_contract_sha256(spec: Mapping[str, Any]) -> str:
    return canonical_sha256(_semantic_contract_payload(spec))


def _validate_render_spec_with_registry(
    value: Mapping[str, Any],
    registry: Mapping[str, Any],
) -> dict[str, Any]:
    spec = _mapping(value, "spec")
    _known_keys(
        spec,
        {
            "schema",
            "source",
            "registry_sha256",
            "renderer",
            "geometry",
            "material",
            "shots",
            "color",
            "sampling",
            "outputs",
            "render_contract_hash",
        },
        "spec",
    )
    if spec.get("schema") != RENDER_SPEC_SCHEMA:
        _invalid(
            "render spec schema 不受支持", field="spec.schema", value=spec.get("schema")
        )
    source = _text(spec.get("source"), "spec.source", allowed={"profile_resolved"})
    registry_hash = _hash_identity(spec.get("registry_sha256"), "spec.registry_sha256")
    renderer, profile = _spec_renderer(spec.get("renderer"), registry)
    geometry = _spec_geometry(spec.get("geometry"), profile)
    material = _normalize_material(spec.get("material"), "spec.material")
    if material != profile["material"]:
        _invalid("spec.material 与已登记 profile 不一致", field="spec.material")
    shots = _spec_shots(spec.get("shots"), profile)
    color = _spec_color(spec.get("color"), profile)
    sampling = _spec_sampling(spec.get("sampling"), profile)
    _enforce_texture_budget(geometry["outer_dimensions_mm"], sampling)
    outputs = _spec_outputs(spec.get("outputs"), profile)
    normalized = {
        "schema": RENDER_SPEC_SCHEMA,
        "source": source,
        "registry_sha256": registry_hash,
        "renderer": renderer,
        "geometry": geometry,
        "material": material,
        "shots": shots,
        "color": color,
        "sampling": sampling,
        "outputs": outputs,
    }
    expected_hash = render_contract_sha256(normalized)
    actual_hash = _hash_identity(
        spec.get("render_contract_hash"), "spec.render_contract_hash"
    )
    if actual_hash != expected_hash:
        _invalid(
            "render_contract_hash 与规范化合同不一致",
            field="spec.render_contract_hash",
            expected=expected_hash,
            actual=actual_hash,
        )
    normalized["render_contract_hash"] = expected_hash
    return normalized


def validate_render_spec(
    spec: Mapping[str, Any],
    *,
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
) -> dict[str, Any]:
    registry = load_profile_registry(registry_path)
    return _validate_render_spec_with_registry(spec, registry)


def resolve_render_spec(
    structure_job: Mapping[str, Any],
    profile_id: str,
    output_request: Mapping[str, Any] | None = None,
    *,
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
) -> dict[str, Any]:
    registry = load_profile_registry(registry_path)
    normalized_profile_id = _identifier(profile_id, "profile_id")
    profile = registry["profiles"].get(normalized_profile_id)
    if profile is None:
        _fail(
            "render_profile_unsupported",
            "渲染 profile 未登记",
            profile_id=normalized_profile_id,
        )
    family, dimensions, structure_hash = _normalize_structure_job(structure_job)
    geometry_profile = profile["geometry"].get(family)
    if geometry_profile is None:
        _fail(
            "render_profile_unsupported",
            "所选 profile 与结构 family 不兼容",
            profile_id=normalized_profile_id,
            family=family,
        )
    studio = dict(profile["studio"])
    studio_profile = studio.pop("profile")
    minimum_ppm = profile["sampling"]["minimum_face_pixels_per_mm"]
    spec: dict[str, Any] = {
        "schema": RENDER_SPEC_SCHEMA,
        "source": "profile_resolved",
        "registry_sha256": registry["registry_sha256"],
        "renderer": {
            **profile["renderer"],
            "profile": normalized_profile_id,
            "profile_sha256": profile["profile_sha256"],
        },
        "geometry": {
            "family": family,
            "structure_hash": structure_hash,
            "outer_dimensions_mm": dimensions,
            **geometry_profile,
        },
        "material": deepcopy(profile["material"]),
        "shots": {"studio_profile": studio_profile, **studio},
        "color": deepcopy(profile["color"]),
        "sampling": {
            **deepcopy(profile["sampling"]),
            "per_face_target_pixels_per_mm": {
                face: minimum_ppm for face in SEMANTIC_FACES
            },
        },
        "outputs": _resolved_output_contract(profile["outputs"], output_request),
    }
    spec["render_contract_hash"] = render_contract_sha256(spec)
    return _validate_render_spec_with_registry(spec, registry)


def current_renderer_config(
    spec: Mapping[str, Any],
    *,
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
) -> dict[str, Any]:
    """Translate a validated spec to the existing renderer's flat config.

    RF-01 does not call this from the product pipeline.  Keeping the translation
    here provides a testable zero-visual-change bridge for the RF-02 wiring.
    """

    normalized = validate_render_spec(spec, registry_path=registry_path)
    material = normalized["material"]
    shots = normalized["shots"]
    color = normalized["color"]
    result = {
        "substrate_rgba": material["substrate_rgba"],
        "resolution_x": shots["master_resolution_px"][0],
        "resolution_y": shots["master_resolution_px"][1],
        "front_rotation_deg": shots["front_rotation_deg"],
        "back_rotation_deg": shots["back_rotation_deg"],
        "material_roughness": material["roughness"],
        "material_specular_ior": material["specular_ior_level"],
        "exact_white_background": shots["exact_white_background"],
        "view_transform": color["view_transform"],
        "look": color["look"],
        "exposure": color["exposure"],
        "world_strength": shots["world_strength"],
        "light_energy_scale": shots["light_energy_scale"],
    }
    if shots["camera_ortho_scale_mm"] is not None:
        result["camera_ortho_scale_mm"] = shots["camera_ortho_scale_mm"]
    return result
