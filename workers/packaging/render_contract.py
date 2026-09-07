"""Strict, versioned render semantics for the existing packaging pipeline.

This module is deliberately the only reader of ``render-profiles.v1.json``,
the RF-06 diagnostic material registry, the RF-07 diagnostic studio
registry, and the RF-08 diagnostic projection-sampling registry.  It resolves accepted
structure facts into a canonical render spec without calling Blender or
changing product output.  Later pipeline slices consume the spec; they
must not recreate profile defaults independently.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys
from typing import Any, Mapping
import zlib


REGISTRY_SCHEMA = "packaging-render-profile-registry/1"
RENDER_SPEC_SCHEMA = "packaging-render-spec/1"
RESOLVED_STRUCTURE_SCHEMA = "resolved-packaging-job/3"
STRUCTURE_SCHEMA = "packaging-structure/1"
COMPAT_LEGACY_PROFILE_ID = "compat-legacy-v0"
RENDER_SPEC_SOURCES = ("profile_resolved", "legacy_synthesized")
RENDER_PLAN_SCHEMA = "packaging-render-plan/1"
RENDER_IDENTITY_KEYS = (
    "render_contract_hash",
    "render_profile_id",
    "render_profile_sha256",
    "render_registry_sha256",
)
PRE_RF02_V2_PIPELINE_VERSIONS = frozenset({"1.4.0"})
LEGACY_RENDER_REQUIRED_KEYS = (
    "substrate_rgba",
    "resolution_x",
    "resolution_y",
    "camera_ortho_scale_mm",
    "front_rotation_deg",
    "back_rotation_deg",
)
LEGACY_RENDER_COMPARE_KEYS = (
    *LEGACY_RENDER_REQUIRED_KEYS,
    "material_roughness",
    "material_specular_ior",
    "exact_white_background",
    "view_transform",
    "look",
    "exposure",
    "world_strength",
    "light_energy_scale",
)
REQUIRED_RENDERER_OUTPUT_KEYS = ("blend", "glb", "front_right", "back_left")
OPTIONAL_RENDERER_OUTPUT_KEYS = (
    "front_right_ground",
    "back_left_ground",
    "front_right_set",
    "back_left_set",
    "front_right_card",
    "back_left_card",
    "front_right_ground_card",
    "back_left_ground_card",
    "front_right_set_card",
    "back_left_set_card",
    "pptx",
    "sheet_pdf",
)
ALLOWED_OUTPUT_KEYS = frozenset(
    REQUIRED_RENDERER_OUTPUT_KEYS + OPTIONAL_RENDERER_OUTPUT_KEYS
)
RENDERER_WRITABLE_OUTPUT_KEYS = frozenset(
    {
        "blend",
        "glb",
        "front_right",
        "back_left",
        "front_right_ground",
        "back_left_ground",
        "front_right_set",
        "back_left_set",
    }
)
OUTPUT_SUFFIX_BY_KEY = {
    "blend": ".blend",
    "glb": ".glb",
    "front_right": ".png",
    "back_left": ".png",
    "front_right_ground": ".png",
    "back_left_ground": ".png",
    "front_right_set": ".png",
    "back_left_set": ".png",
    "front_right_card": ".png",
    "back_left_card": ".png",
    "front_right_ground_card": ".png",
    "back_left_ground_card": ".png",
    "front_right_set_card": ".png",
    "back_left_set_card": ".png",
    "pptx": ".pptx",
    "sheet_pdf": ".pdf",
}
RENDERER_CONSUMED_JOB_KEYS = (
    "code",
    "slug",
    "display_name",
    "source_ai",
    "template_path",
    "project_dir",
    "resolved_job_path",
    "dimensions_mm",
    "glb_tolerance_mm",
    "structure_schema",
    "structure_hash",
    "packaging_family",
    "assets",
    "outputs",
    "render",
    "render_spec",
    *RENDER_IDENTITY_KEYS,
)
# Historical V1/CLI diagnostic render. Not a V2 fact source and not copied
# from registry internals. Production templates must not grow a scattered
# `render` object again.
V1_DIAGNOSTIC_RENDER_BY_TEMPLATE_ID = {
    "flower_box_square_47_5x47_5x177_5": {
        "substrate_rgba": [1.0, 1.0, 1.0, 1.0],
        "resolution_x": 3000,
        "resolution_y": 3600,
        "camera_ortho_scale_mm": 224.0,
        "front_rotation_deg": 0.0,
        "back_rotation_deg": 180.0,
    },
    "flower_box_illustrator_smoke": {
        "substrate_rgba": [1.0, 1.0, 1.0, 1.0],
        "resolution_x": 1200,
        "resolution_y": 1440,
        "camera_ortho_scale_mm": 224.0,
        "front_rotation_deg": 0.0,
        "back_rotation_deg": 180.0,
    },
}
DEFAULT_REGISTRY_PATH = (
    Path(__file__).resolve().parent / "profiles" / "render-profiles.v1.json"
)
EXPERIMENTAL_MATERIAL_REGISTRY_PATH = (
    Path(__file__).resolve().parent / "profiles" / "experiments" / "rf06-materials.v1.json"
)
EXPERIMENTAL_STUDIO_REGISTRY_PATH = (
    Path(__file__).resolve().parent / "profiles" / "experiments" / "rf07-studio-color.v1.json"
)
EXPERIMENTAL_PROJECTION_REGISTRY_PATH = (
    Path(__file__).resolve().parent
    / "profiles"
    / "experiments"
    / "rf08-projection-sampling.v1.json"
)
PROJECTION_SAMPLING_STRATEGY = "projection-jacobian-v1"
SAMPLING_STRATEGIES = frozenset({"minimum-floor-v1", PROJECTION_SAMPLING_STRATEGY})
F_STUDIO_PROFILE = "normalized-three-area-f-v1"
EXPLICIT_STUDIO_PROFILE = "normalized-three-area-explicit-v1"
STUDIO_PROFILES = frozenset(
    {
        "legacy-fixed-three-area-v0",
        "three-softbox-no-hdri-v1",
        F_STUDIO_PROFILE,
        EXPLICIT_STUDIO_PROFILE,
    }
)
F_RIG_FIELDS = {
    "rig_reference_mm": 180.0,
    "fill_energy_multiplier": 0.35,
    "key_elevation_delta_deg": -15.0,
}
EXPLICIT_STUDIO_KEYS = frozenset(
    {
        "reference_target_mm",
        "camera_space_shots",
        "world_hdri",
        "world_color",
        "lights",
    }
)
STUDIO_LIGHT_ROLES = ("key", "fill", "rim")
STUDIO_LIGHT_NAMES = {
    "key": "Key softbox",
    "fill": "Fill softbox",
    "rim": "Rim softbox",
}

SEMANTIC_FACES = ("front", "right", "back", "left", "top", "bottom")
RENDER_FAMILIES = ("rectangular_carton_v1", "pouch_thin_card_v1")
VIEW_IDS = ("front_right", "back_left")
SUBSTRATE_PROFILES = frozenset({"white-card-default-v1", "kraft-card-v1"})
FINISH_PROFILES = frozenset(
    {"none", "overall-matte-lamination-v1", "overall-gloss-varnish-v1"}
)
MICRO_NORMAL_SIZES_PX = frozenset({16, 32, 64, 128})
GLB_CLEARCOAT_EXTENSION = "KHR_materials_clearcoat"
LEGACY_CORE_ROUGHNESS = 0.6
LEGACY_CORE_SPECULAR_IOR = 0.5
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

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
    _known_keys(renderer, {"engine", "minimum_blender_version", "samples", "shadow_pool_size_mb"}, label)
    resources = {}
    if "shadow_pool_size_mb" in renderer:
        pool = _integer(renderer["shadow_pool_size_mb"], f"{label}.shadow_pool_size_mb", lower=1024, upper=1024)
        resources["shadow_pool_size_mb"] = pool
    return {
        **resources,
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
            "thickness_mm",
            "bevel_segments",
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
    shell = geometry.get("closure_detail") == "closed-carton-shell-v1"
    physical = {}
    if shell:
        if family != "rectangular_carton_v1" or preview != "carton_physical_v1":
            _invalid("纸板壳只支持矩形纸盒", field=label)
        physical = {
            "thickness_mm": _number(geometry.get("thickness_mm"), f"{label}.thickness_mm", lower=0.01, upper=5.0),
            "bevel_segments": _integer(geometry.get("bevel_segments"), f"{label}.bevel_segments", lower=2, upper=4),
        }
        bevel = _number(geometry.get("core_bevel_mm"), f"{label}.core_bevel_mm", lower=0.0, upper=10.0)
        gap = _number(geometry.get("surface_gap_mm"), f"{label}.surface_gap_mm", lower=0.0, upper=10.0)
        if bevel <= 0 or gap <= 0:
            _invalid("纸板壳倒角与印刷间隙必须大于零", field=label)
    elif "thickness_mm" in geometry or "bevel_segments" in geometry:
        _invalid("旧几何不能声明纸板壳参数", field=label)
    return {
        **physical,
        "substrate_profile": _text(
            geometry.get("substrate_profile"),
            f"{label}.substrate_profile",
            allowed=set(SUBSTRATE_PROFILES),
        ),
        "closure_detail": _text(
            geometry.get("closure_detail"),
            f"{label}.closure_detail",
            allowed=(
                {"legacy-closed-box-v0", "closed-carton-visual-v1", "closed-carton-shell-v1"}
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


def _normalize_micro_normal(value: Any, label: str) -> dict[str, Any]:
    normal = _mapping(value, label)
    _known_keys(normal, {"kind", "size_px", "seed", "strength", "color_space"}, label)
    size = _integer(normal.get("size_px"), f"{label}.size_px", lower=16, upper=128)
    if size not in MICRO_NORMAL_SIZES_PX:
        _invalid("微法线尺寸必须是固定预算档位", field=f"{label}.size_px", value=size)
    strength = _number(normal.get("strength"), f"{label}.strength", lower=0.0, upper=1.0)
    if strength <= 0:
        _invalid("微法线强度必须大于零", field=f"{label}.strength")
    return {
        "kind": _text(normal.get("kind"), f"{label}.kind", allowed={"procedural-micro-v1"}),
        "size_px": size,
        "seed": _integer(normal.get("seed"), f"{label}.seed", lower=0, upper=2_147_483_647),
        "strength": strength,
        "color_space": _text(
            normal.get("color_space"), f"{label}.color_space", allowed={"Non-Color"}
        ),
    }


def _normalize_glb_export(
    value: Any, label: str, *, has_coat: bool, has_normal: bool
) -> dict[str, Any]:
    export = _mapping(value, label)
    _known_keys(export, {"roughness", "clearcoat", "normal", "extensions"}, label)
    roughness = _boolean(export.get("roughness"), f"{label}.roughness")
    if not roughness:
        _invalid("GLB 必须导出 roughness", field=f"{label}.roughness")
    clearcoat = _boolean(export.get("clearcoat"), f"{label}.clearcoat")
    normal = _boolean(export.get("normal"), f"{label}.normal")
    extensions: list[str] = []
    for index, item in enumerate(_list(export.get("extensions"), f"{label}.extensions")):
        ext = _text(
            item,
            f"{label}.extensions[{index}]",
            allowed={GLB_CLEARCOAT_EXTENSION},
        )
        if ext in extensions:
            _invalid("GLB extensions 不能重复", field=f"{label}.extensions")
        extensions.append(ext)
    if clearcoat and GLB_CLEARCOAT_EXTENSION not in extensions:
        _invalid(
            "clearcoat 导出必须列入 KHR_materials_clearcoat",
            field=f"{label}.extensions",
        )
    if not clearcoat and extensions:
        _invalid("未导出 clearcoat 时不得声明该扩展", field=f"{label}.extensions")
    if clearcoat and not has_coat:
        _invalid("声明 GLB clearcoat 必须有 coat 参数", field=label)
    if normal and not has_normal:
        _invalid("声明 GLB normal 必须有微法线", field=label)
    return {
        "roughness": True,
        "clearcoat": clearcoat,
        "normal": normal,
        "extensions": extensions,
    }


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
            "ink_color_space",
            "coat_weight",
            "coat_roughness",
            "core_roughness",
            "core_specular_ior_level",
            "substrate_micro_normal",
            "glb_export",
        },
        label,
    )
    if material.get("spot_finish_mask") is not None:
        _fail(
            "render_finish_mask_unsupported",
            "局部工艺必须绑定后续切片提供的独立语义 mask",
            field=f"{label}.spot_finish_mask",
        )
    finish = _text(
        material.get("finish_profile"),
        f"{label}.finish_profile",
        allowed=set(FINISH_PROFILES),
    )
    extras: dict[str, Any] = {}
    if "ink_color_space" in material:
        extras["ink_color_space"] = _text(
            material.get("ink_color_space"),
            f"{label}.ink_color_space",
            allowed={"sRGB"},
        )
    if "core_roughness" in material:
        extras["core_roughness"] = _number(
            material.get("core_roughness"),
            f"{label}.core_roughness",
            lower=0.0,
            upper=1.0,
        )
    if "core_specular_ior_level" in material:
        extras["core_specular_ior_level"] = _number(
            material.get("core_specular_ior_level"),
            f"{label}.core_specular_ior_level",
            lower=0.0,
            upper=1.0,
        )
    has_coat_fields = "coat_weight" in material or "coat_roughness" in material
    if finish == "overall-gloss-varnish-v1":
        if "coat_weight" not in material or "coat_roughness" not in material:
            _invalid("整体上光必须显式声明 coat", field=label)
        extras["coat_weight"] = _number(
            material.get("coat_weight"), f"{label}.coat_weight", lower=0.0, upper=1.0
        )
        extras["coat_roughness"] = _number(
            material.get("coat_roughness"),
            f"{label}.coat_roughness",
            lower=0.0,
            upper=1.0,
        )
        if extras["coat_weight"] <= 0:
            _invalid("整体上光的 coat_weight 必须大于零", field=f"{label}.coat_weight")
    elif has_coat_fields:
        _invalid("无涂层/哑膜不能声明 coat", field=label)
    if "substrate_micro_normal" in material:
        extras["substrate_micro_normal"] = _normalize_micro_normal(
            material.get("substrate_micro_normal"), f"{label}.substrate_micro_normal"
        )
    if "glb_export" in material:
        extras["glb_export"] = _normalize_glb_export(
            material.get("glb_export"),
            f"{label}.glb_export",
            has_coat="coat_weight" in extras,
            has_normal="substrate_micro_normal" in extras,
        )
        if finish == "overall-gloss-varnish-v1" and extras["glb_export"]["clearcoat"] is False:
            # Explicit false is honest still-vs-GLB degradation, not a schema error.
            pass
    return {
        "substrate_profile": _text(
            material.get("substrate_profile"),
            f"{label}.substrate_profile",
            allowed=set(SUBSTRATE_PROFILES),
        ),
        "print_layer": _text(
            material.get("print_layer"),
            f"{label}.print_layer",
            allowed={"process-ink-v1"},
        ),
        "finish_profile": finish,
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
        **extras,
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


def _vec3(value: Any, label: str, *, lower: float | None = None, upper: float | None = None) -> list[float]:
    items = _list(value, label)
    if len(items) != 3:
        _invalid(f"{label} 必须是长度为 3 的数组", field=label)
    return [
        _number(items[index], f"{label}[{index}]", lower=lower, upper=upper)
        for index in range(3)
    ]


def _normalize_studio_light(value: Any, label: str, role: str) -> dict[str, Any]:
    light = _mapping(value, label)
    _known_keys(
        light,
        {
            "name",
            "location_mm",
            "type",
            "shape",
            "size_mm",
            "size_y_mm",
            "energy_base",
            "energy_ratio",
        },
        label,
    )
    shape = _text(
        light.get("shape"),
        f"{label}.shape",
        allowed={"RECTANGLE", "SQUARE", "DISK", "ELLIPSE"},
    )
    payload = {
        "name": _text(
            light.get("name"),
            f"{label}.name",
            allowed={STUDIO_LIGHT_NAMES[role]},
        ),
        "location_mm": _vec3(light.get("location_mm"), f"{label}.location_mm"),
        "type": _text(light.get("type"), f"{label}.type", allowed={"AREA"}),
        "shape": shape,
        "size_mm": _number(light.get("size_mm"), f"{label}.size_mm", lower=0.001, upper=10_000.0),
        "energy_base": _number(
            light.get("energy_base"), f"{label}.energy_base", lower=0.0, upper=10_000_000.0
        ),
        "energy_ratio": _number(
            light.get("energy_ratio"), f"{label}.energy_ratio", lower=0.0, upper=10.0
        ),
    }
    if shape in {"RECTANGLE", "ELLIPSE"}:
        payload["size_y_mm"] = _number(
            light.get("size_y_mm"), f"{label}.size_y_mm", lower=0.001, upper=10_000.0
        )
    elif "size_y_mm" in light:
        _invalid("非矩形/椭圆灯不能声明 size_y_mm", field=f"{label}.size_y_mm")
    return payload


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
            "rig_reference_mm",
            "fill_energy_multiplier",
            "key_elevation_delta_deg",
            *EXPLICIT_STUDIO_KEYS,
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
    rig = {}
    profile_id = _text(
        studio.get("profile"),
        f"{label}.profile",
        allowed=set(STUDIO_PROFILES),
    )
    if profile_id in {F_STUDIO_PROFILE, EXPLICIT_STUDIO_PROFILE}:
        for key, expected in F_RIG_FIELDS.items():
            rig[key] = _number(studio.get(key), f"{label}.{key}", lower=expected, upper=expected)
    elif any(key in studio for key in F_RIG_FIELDS):
        _invalid("旧灯光不得携带 F 参数", field=label)
    explicit = {}
    if profile_id == EXPLICIT_STUDIO_PROFILE:
        missing = sorted(key for key in EXPLICIT_STUDIO_KEYS if key not in studio)
        if missing:
            _invalid("显式棚光缺少合同字段", field=label, missing=missing)
        reference_target = _vec3(studio.get("reference_target_mm"), f"{label}.reference_target_mm")
        if reference_target != [0.0, 0.0, rig["rig_reference_mm"] / 2.0]:
            _invalid("参考目标必须是参考尺寸中心", field=f"{label}.reference_target_mm")
        if _boolean(studio.get("world_hdri"), f"{label}.world_hdri"):
            _invalid("显式棚光禁止 HDRI", field=f"{label}.world_hdri")
        if not _boolean(studio.get("camera_space_shots"), f"{label}.camera_space_shots"):
            _invalid("正反 shot 必须保持相机空间灯位", field=f"{label}.camera_space_shots")
        lights = _mapping(studio.get("lights"), f"{label}.lights")
        if set(lights) != set(STUDIO_LIGHT_ROLES):
            _invalid("显式棚光必须声明 key/fill/rim", field=f"{label}.lights")
        normalized_lights = {
            role: _normalize_studio_light(lights[role], f"{label}.lights.{role}", role)
            for role in STUDIO_LIGHT_ROLES
        }
        if normalized_lights["fill"]["energy_ratio"] != rig["fill_energy_multiplier"]:
            _invalid("fill 能量比必须等于 fill_energy_multiplier", field=f"{label}.lights.fill.energy_ratio")
        if normalized_lights["key"]["energy_ratio"] != 1.0 or normalized_lights["rim"]["energy_ratio"] != 1.0:
            _invalid("key/rim 能量比必须为 1", field=f"{label}.lights")
        explicit = {
            "reference_target_mm": reference_target,
            "camera_space_shots": True,
            "world_hdri": False,
            "world_color": _vec3(studio.get("world_color"), f"{label}.world_color", lower=0.0, upper=1.0),
            "lights": normalized_lights,
        }
    elif any(key in studio for key in EXPLICIT_STUDIO_KEYS):
        _invalid("旧灯光不得携带 RF07 显式灯位", field=label)
    return {
        **rig,
        **explicit,
        "profile": profile_id,
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
            allowed=set(SAMPLING_STRATEGIES),
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
    if payload["studio"]["profile"] in {F_STUDIO_PROFILE, EXPLICIT_STUDIO_PROFILE} and payload["renderer"].get("shadow_pool_size_mb") != 1024:
        _invalid("尺寸归一棚光必须显式声明 1024 MB 阴影池", field=f"{label}.renderer")
    material_substrate = payload["material"]["substrate_profile"]
    for family, geometry in payload["geometry"].items():
        if geometry["substrate_profile"] != material_substrate:
            _invalid(
                "geometry 与 material 的纸材声明必须一致",
                field=f"{label}.geometry.{family}.substrate_profile",
            )
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
    previous_ids = list(previous["profiles"])
    candidate_ids = list(candidate["profiles"])
    if candidate_ids[: len(previous_ids)] != previous_ids:
        _invalid(
            "已登记 profile 必须保持原顺序，新增 ID 只能追加",
            field="registry.profiles",
            previous=previous_ids,
            candidate_prefix=candidate_ids[: len(previous_ids)],
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
    if output_request is None:
        request: Mapping[str, Any] = {}
    else:
        request = _mapping(output_request, "output_request")
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
            "thickness_mm",
            "bevel_segments",
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
    _known_keys(geometry, {"family", "structure_hash", "outer_dimensions_mm", *expected}, "spec.geometry")
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
        {"engine", "minimum_blender_version", "samples", "profile", "profile_sha256", "shadow_pool_size_mb"},
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
            **({"shadow_pool_size_mb": renderer["shadow_pool_size_mb"]} if "shadow_pool_size_mb" in renderer else {}),
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
            "rig_reference_mm",
            "fill_energy_multiplier",
            "key_elevation_delta_deg",
            *EXPLICIT_STUDIO_KEYS,
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


def _projection_report(
    dimensions: Mapping[str, float],
    shots: Mapping[str, Any],
    sampling: Mapping[str, Any],
) -> dict[str, Any]:
    root = str(Path(__file__).resolve().parent)
    if root not in sys.path:
        sys.path.insert(0, root)
    from camera_frame import project_face_sampling

    try:
        return project_face_sampling(dict(dimensions), dict(shots), dict(sampling))
    except (ValueError, KeyError, TypeError, ZeroDivisionError) as error:
        _invalid(
            "无法从实际相机计算切面投影采样",
            field="spec.sampling",
            cause=str(error),
        )


def _fail_projection_budget(violation: Mapping[str, Any]) -> None:
    _fail(
        "render_texture_budget_exceeded",
        "语义面投影清晰度超过纹理预算，禁止静默降采样",
        **dict(violation),
    )


def _spec_sampling(
    value: Any,
    profile: Mapping[str, Any],
    *,
    dimensions: Mapping[str, float],
    shots: Mapping[str, Any],
) -> dict[str, Any]:
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
    if fixed["strategy"] == PROJECTION_SAMPLING_STRATEGY:
        report = _projection_report(dimensions, shots, fixed)
        if report["budget_violations"]:
            _fail_projection_budget(report["budget_violations"][0])
        expected = report["per_face_target_pixels_per_mm"]
        normalized_targets = {
            face: _number(
                targets.get(face),
                f"spec.sampling.per_face_target_pixels_per_mm.{face}",
                lower=fixed["minimum_face_pixels_per_mm"],
                upper=fixed["maximum_face_pixels_per_mm"],
            )
            for face in SEMANTIC_FACES
        }
        if any(
            abs(normalized_targets[face] - expected[face]) > 1e-9
            for face in SEMANTIC_FACES
        ):
            _invalid(
                "投影采样目标必须等于未截断的相机需求",
                field="spec.sampling.per_face_target_pixels_per_mm",
                expected=expected,
                actual=normalized_targets,
            )
        return {**fixed, "per_face_target_pixels_per_mm": expected}
    normalized_targets = {
        face: _number(
            targets.get(face),
            f"spec.sampling.per_face_target_pixels_per_mm.{face}",
            lower=fixed["minimum_face_pixels_per_mm"],
            upper=fixed["maximum_face_pixels_per_mm"],
        )
        for face in SEMANTIC_FACES
    }
    if any(
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
            extra = {}
            message = "语义面在最低清晰度下仍超过纹理像素预算，禁止静默降采样"
            if sampling.get("strategy") == PROJECTION_SAMPLING_STRATEGY:
                extra = {
                    "required_pixels_per_mm": ppm,
                    "allowed_pixels_per_mm": sampling["maximum_face_pixels_per_mm"],
                    "oversample_ratio": sampling["oversample_ratio"],
                }
                message = "语义面在目标清晰度下仍超过纹理像素预算，禁止静默降采样"
            _fail(
                "render_texture_budget_exceeded",
                message,
                face=face,
                required_pixels=required,
                allowed_pixels=allowed,
                required_size_px=[width_px, height_px],
                target_pixels_per_mm=ppm,
                **extra,
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


def _registry_for_persisted_identity(registry_hash: str, current: Mapping[str, Any]) -> Mapping[str, Any]:
    """Only a source-controlled, byte-pinned historical registry can be replayed.

    Never choose a path from job data or silently re-sign a persisted contract.
    Current registry must still contain all historical visual identities.
    """
    if registry_hash == current["registry_sha256"]:
        return current
    histories = {
        "sha256:1f490d26590ddcb5a100fa3087d9d36649b7a98e4722cf521f6f342da718ad07": "pre-rf05.v1.json",
        "sha256:38ee501b794e9979a8ab06f2e0e1a476271ea9c7897c41eed3460d0f0acfc77b": "pre-f.v1.json",
    }
    if registry_hash not in histories:
        for diagnostic in (
            EXPERIMENTAL_MATERIAL_REGISTRY_PATH,
            EXPERIMENTAL_STUDIO_REGISTRY_PATH,
            EXPERIMENTAL_PROJECTION_REGISTRY_PATH,
        ):
            if diagnostic.is_file():
                loaded = load_profile_registry(diagnostic)
                if loaded["registry_sha256"] == registry_hash:
                    return loaded
        _invalid("spec.registry_sha256 未在受信任历史中登记", field="spec.registry_sha256")
    historical = load_profile_registry(DEFAULT_REGISTRY_PATH.parent / "history" / histories[registry_hash])
    if historical["registry_sha256"] != registry_hash:
        _invalid("历史 registry 字节身份不一致", field="spec.registry_sha256")
    for profile_id, profile in historical["profiles"].items():
        if current["profiles"].get(profile_id) != profile:
            _invalid("当前 registry 不再兼容历史视觉身份", field="registry.profiles", profile_id=profile_id)
    return historical


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
    source = _text(
        spec.get("source"), "spec.source", allowed=set(RENDER_SPEC_SOURCES)
    )
    registry_hash = _hash_identity(spec.get("registry_sha256"), "spec.registry_sha256")
    registry = _registry_for_persisted_identity(registry_hash, registry)
    renderer, profile = _spec_renderer(spec.get("renderer"), registry)
    geometry = _spec_geometry(spec.get("geometry"), profile)
    material = _normalize_material(spec.get("material"), "spec.material")
    if material != profile["material"]:
        _invalid("spec.material 与已登记 profile 不一致", field="spec.material")
    shots = _spec_shots(spec.get("shots"), profile)
    color = _spec_color(spec.get("color"), profile)
    sampling = _spec_sampling(
        spec.get("sampling"),
        profile,
        dimensions=geometry["outer_dimensions_mm"],
        shots=shots,
    )
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


def _resolve_render_spec_with_registry(
    structure_job: Mapping[str, Any],
    profile_id: str,
    output_request: Mapping[str, Any] | None,
    registry: Mapping[str, Any],
) -> dict[str, Any]:
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
    shots = {"studio_profile": studio_profile, **studio}
    sampling = deepcopy(profile["sampling"])
    if sampling["strategy"] == PROJECTION_SAMPLING_STRATEGY:
        report = _projection_report(dimensions, shots, sampling)
        if report["budget_violations"]:
            _fail_projection_budget(report["budget_violations"][0])
        sampling["per_face_target_pixels_per_mm"] = report["per_face_target_pixels_per_mm"]
    else:
        minimum_ppm = sampling["minimum_face_pixels_per_mm"]
        sampling["per_face_target_pixels_per_mm"] = {
            face: minimum_ppm for face in SEMANTIC_FACES
        }
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
        "shots": shots,
        "color": deepcopy(profile["color"]),
        "sampling": sampling,
        "outputs": _resolved_output_contract(profile["outputs"], output_request),
    }
    spec["render_contract_hash"] = render_contract_sha256(spec)
    return _validate_render_spec_with_registry(spec, registry)


def resolve_render_spec(
    structure_job: Mapping[str, Any],
    profile_id: str,
    output_request: Mapping[str, Any] | None = None,
    *,
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
) -> dict[str, Any]:
    registry = load_profile_registry(registry_path)
    return _resolve_render_spec_with_registry(
        structure_job, profile_id, output_request, registry
    )


def _legacy_asset_faces(assets: Any) -> dict[str, str]:
    mapping = _mapping(assets, "legacy_job.assets")
    missing = [
        face
        for face in SEMANTIC_FACES
        if not str(mapping.get(face) or "").strip()
    ]
    if missing:
        _fail(
            "render_family_unsupported",
            "旧作业缺少可证明的完整六面，不能合成兼容合同",
            missing_faces=missing,
        )
    return {face: str(mapping[face]).strip() for face in SEMANTIC_FACES}


def _structure_job_from_legacy_resolved(
    resolved_job: Mapping[str, Any],
    *,
    require_assets: bool,
) -> dict[str, Any]:
    job = _mapping(resolved_job, "legacy_job")
    if job.get("structure_schema") != STRUCTURE_SCHEMA:
        _fail(
            "render_family_unsupported",
            "旧作业缺少可证明的结构身份，不能合成兼容合同",
            field="legacy_job.structure_schema",
            value=job.get("structure_schema"),
        )
    structure_hash = _hash_identity(
        job.get("structure_hash"), "legacy_job.structure_hash"
    )
    dimensions = _normalize_dimensions(
        job.get("dimensions_mm"), "legacy_job.dimensions_mm"
    )
    if require_assets:
        _legacy_asset_faces(job.get("assets"))
    structure_job: dict[str, Any] = {
        "schema": RESOLVED_STRUCTURE_SCHEMA,
        "structure_schema": STRUCTURE_SCHEMA,
        "structure_hash": structure_hash,
        "dimensions_mm": dimensions,
        "faces": {face: {} for face in SEMANTIC_FACES},
        "validation": {"status": "accepted", "errors": [], "warnings": []},
    }
    declared_family = job.get("packaging_family")
    if declared_family is not None:
        structure_job["packaging_family"] = declared_family
    return structure_job


def _synthesize_legacy_with_registry(
    resolved_job: Mapping[str, Any],
    output_request: Mapping[str, Any] | None,
    registry: Mapping[str, Any],
) -> dict[str, Any]:
    structure_job = _structure_job_from_legacy_resolved(
        resolved_job, require_assets=True
    )
    resolved = _resolve_render_spec_with_registry(
        structure_job, COMPAT_LEGACY_PROFILE_ID, output_request, registry
    )
    if resolved["source"] != "profile_resolved":
        _invalid(
            "resolve_render_spec 必须只产生 profile_resolved",
            field="spec.source",
            value=resolved["source"],
        )
    synthesized = dict(resolved)
    synthesized["source"] = "legacy_synthesized"
    synthesized["render_contract_hash"] = render_contract_sha256(synthesized)
    validated = _validate_render_spec_with_registry(synthesized, registry)
    _assert_legacy_render_matches_compat(
        resolved_job, _renderer_config_from_normalized(validated)
    )
    return validated


def synthesize_legacy_render_spec(
    resolved_job: Mapping[str, Any],
    output_request: Mapping[str, Any] | None = None,
    *,
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
) -> dict[str, Any]:
    """Build a compat-legacy-v0 spec from persisted historical job facts.

    New tasks must call ``resolve_render_spec`` and always persist
    ``source=profile_resolved``.  This entry is only for blender-only relight
    of jobs that never stored a render spec.
    """

    registry = load_profile_registry(registry_path)
    return _synthesize_legacy_with_registry(resolved_job, output_request, registry)


def _renderer_config_from_normalized(normalized: Mapping[str, Any]) -> dict[str, Any]:
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
    if shots["studio_profile"] in {F_STUDIO_PROFILE, EXPLICIT_STUDIO_PROFILE}:
        result["studio_profile"] = shots["studio_profile"]
        for key in ("rig_reference_mm", "fill_energy_multiplier", "key_elevation_delta_deg"):
            result[key] = shots[key]
    if "shadow_pool_size_mb" in normalized["renderer"]:
        result["shadow_pool_size_mb"] = normalized["renderer"]["shadow_pool_size_mb"]
    if "coat_weight" in material:
        result["material_coat_weight"] = material["coat_weight"]
        result["material_coat_roughness"] = material["coat_roughness"]
    if "ink_color_space" in material:
        result["ink_color_space"] = material["ink_color_space"]
    if "core_roughness" in material:
        result["material_core_roughness"] = material["core_roughness"]
    if "core_specular_ior_level" in material:
        result["material_core_specular_ior"] = material["core_specular_ior_level"]
    return result


def current_renderer_config(
    spec: Mapping[str, Any],
    *,
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
) -> dict[str, Any]:
    """Translate a validated spec to the existing renderer's flat config.

    Pipeline wiring consumes a persistable render plan instead of calling this
    on the hot path.  Tests still use it as the RF-01 zero-visual-change bridge.
    """

    normalized = validate_render_spec(spec, registry_path=registry_path)
    return _renderer_config_from_normalized(normalized)


def load_experimental_material_registry() -> dict[str, Any]:
    """Load the RF-06 diagnostic registry.  Not a production default."""

    return load_profile_registry(EXPERIMENTAL_MATERIAL_REGISTRY_PATH)


def load_experimental_studio_registry() -> dict[str, Any]:
    """Load the RF-07 diagnostic studio registry.  Not a production default."""

    return load_profile_registry(EXPERIMENTAL_STUDIO_REGISTRY_PATH)


def render_plan_for_experimental_material_job(
    structure_job: Mapping[str, Any],
    profile_id: str,
    output_request: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Explicit diagnostic entry for candidate paper/ink/finish profiles."""

    return render_plan_for_new_job(
        structure_job,
        profile_id,
        output_request,
        registry_path=EXPERIMENTAL_MATERIAL_REGISTRY_PATH,
    )


def render_plan_for_experimental_studio_job(
    structure_job: Mapping[str, Any],
    profile_id: str,
    output_request: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Explicit diagnostic entry for the RF-07 size-normalized studio candidate."""

    return render_plan_for_new_job(
        structure_job,
        profile_id,
        output_request,
        registry_path=EXPERIMENTAL_STUDIO_REGISTRY_PATH,
    )


def load_experimental_projection_registry() -> dict[str, Any]:
    """Load the RF-08 diagnostic projection-sampling registry.  Not a production default."""

    return load_profile_registry(EXPERIMENTAL_PROJECTION_REGISTRY_PATH)


def render_plan_for_experimental_projection_job(
    structure_job: Mapping[str, Any],
    profile_id: str,
    output_request: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Explicit diagnostic entry for per-face camera Jacobian sampling."""

    return render_plan_for_new_job(
        structure_job,
        profile_id,
        output_request,
        registry_path=EXPERIMENTAL_PROJECTION_REGISTRY_PATH,
    )


def scaled_explicit_studio_lights(
    studio: Mapping[str, Any],
    dimensions: Mapping[str, Any],
) -> dict[str, Any]:
    """Scale the declared reference rig by bbox longest edge.  Size only."""

    normalized = _normalize_studio(studio, "studio")
    if normalized["profile"] != EXPLICIT_STUDIO_PROFILE:
        _invalid("只有显式棚光才能按参考尺寸缩放", field="studio.profile")
    width = _number(dimensions.get("width"), "dimensions_mm.width", lower=0.001, upper=MAX_DIMENSION_MM)
    depth = _number(dimensions.get("depth"), "dimensions_mm.depth", lower=0.001, upper=MAX_DIMENSION_MM)
    height = _number(dimensions.get("height"), "dimensions_mm.height", lower=0.001, upper=MAX_DIMENSION_MM)
    scale = max(width, depth, height) / normalized["rig_reference_mm"]
    target = (0.0, 0.0, height / 2.0)
    reference = tuple(normalized["reference_target_mm"])
    energy_scale = normalized["light_energy_scale"]
    lights: dict[str, Any] = {}
    for role in STUDIO_LIGHT_ROLES:
        src = normalized["lights"][role]
        loc = tuple(src["location_mm"])
        scaled_loc = [
            target[0] + scale * (loc[0] - reference[0]),
            target[1] + scale * (loc[1] - reference[1]),
            target[2] + scale * (loc[2] - reference[2]),
        ]
        size_y = None
        if src["shape"] in {"RECTANGLE", "ELLIPSE"}:
            size_y = src["size_y_mm"] * scale
        lights[role] = {
            "name": src["name"],
            "location_mm": scaled_loc,
            "shape": src["shape"],
            "size_mm": src["size_mm"] * scale,
            "size_y_mm": size_y,
            "energy": src["energy_base"] * energy_scale * scale * scale,
            "energy_ratio": src["energy_ratio"],
        }
    lights["fill"]["energy"] *= normalized["fill_energy_multiplier"]
    key_loc = lights["key"]["location_mm"]
    offset = (key_loc[0] - target[0], key_loc[1] - target[1], key_loc[2] - target[2])
    distance = math.sqrt(sum(component * component for component in offset))
    azimuth = math.atan2(offset[1], offset[0])
    elevation = math.atan2(offset[2], math.hypot(offset[0], offset[1])) + math.radians(
        normalized["key_elevation_delta_deg"]
    )
    lights["key"]["location_mm"] = [
        target[0] + distance * math.cos(elevation) * math.cos(azimuth),
        target[1] + distance * math.cos(elevation) * math.sin(azimuth),
        target[2] + distance * math.sin(elevation),
    ]
    return {
        "scale": scale,
        "target_mm": list(target),
        "camera_space_shots": True,
        "world_hdri": False,
        "world_strength": normalized["world_strength"],
        "world_color": list(normalized["world_color"]),
        "lights": lights,
    }


def _hash32(x: int, y: int, seed: int) -> int:
    value = (x * 374761393 + y * 668265263 + seed * 144737) & 0xFFFFFFFF
    value = (value ^ (value >> 13)) * 1274126177 & 0xFFFFFFFF
    return value & 0xFFFFFFFF


def _png_rgba_bytes(width: int, height: int, pixels: bytes) -> bytes:
    if len(pixels) != width * height * 4:
        _invalid("微法线像素缓冲与尺寸不一致", field="substrate_micro_normal")

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(
        b"\x00" + pixels[row * width * 4 : (row + 1) * width * 4]
        for row in range(height)
    )
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return PNG_SIGNATURE + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def substrate_micro_normal_png_bytes(spec: Mapping[str, Any]) -> bytes:
    """Deterministic, bounded tangent-space normal map.  Non-Color data."""

    normal = _normalize_micro_normal(spec, "substrate_micro_normal")
    size = int(normal["size_px"])
    seed = int(normal["seed"])

    def height(x: int, y: int) -> float:
        return _hash32(x % size, y % size, seed) / 4294967295.0 * 2.0 - 1.0

    pixels = bytearray(size * size * 4)
    scale = 0.12
    offset = 0
    for y in range(size):
        for x in range(size):
            dx = height(x + 1, y) - height(x - 1, y)
            dy = height(x, y + 1) - height(x, y - 1)
            nx = -dx * scale
            ny = -dy * scale
            nz = 1.0
            length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
            pixels[offset] = int(round((nx / length * 0.5 + 0.5) * 255.0))
            pixels[offset + 1] = int(round((ny / length * 0.5 + 0.5) * 255.0))
            pixels[offset + 2] = int(round((nz / length * 0.5 + 0.5) * 255.0))
            pixels[offset + 3] = 255
            offset += 4
    return _png_rgba_bytes(size, size, bytes(pixels))


def resolved_material_layers(material: Mapping[str, Any]) -> dict[str, Any]:
    """Single parser for substrate / ink / overall finish / unsupported spot."""

    normalized = _normalize_material(material, "material")
    micro = normalized.get("substrate_micro_normal")
    coat_weight = normalized.get("coat_weight")
    still_coat = coat_weight is not None and coat_weight > 0
    still_normal = micro is not None
    declared = normalized.get("glb_export")
    if declared is None:
        glb_export = {
            "roughness": True,
            "clearcoat": still_coat,
            "normal": still_normal,
            "extensions": [GLB_CLEARCOAT_EXTENSION] if still_coat else [],
        }
    else:
        glb_export = deepcopy(declared)
    micro_png = substrate_micro_normal_png_bytes(micro) if micro is not None else None
    return {
        "substrate": {
            "profile": normalized["substrate_profile"],
            "rgba": list(normalized["substrate_rgba"]),
            "roughness": normalized["roughness"],
            "core_roughness": normalized.get("core_roughness", LEGACY_CORE_ROUGHNESS),
            "core_specular_ior_level": normalized.get(
                "core_specular_ior_level", LEGACY_CORE_SPECULAR_IOR
            ),
            "specular_ior_level": normalized["specular_ior_level"],
            "micro_normal": deepcopy(micro) if micro is not None else None,
        },
        "ink": {
            "print_layer": normalized["print_layer"],
            "color_space": normalized.get("ink_color_space", "sRGB"),
            "alpha": "MASK",
        },
        "overall_finish": {
            "profile": normalized["finish_profile"],
            "coat_weight": coat_weight,
            "coat_roughness": normalized.get("coat_roughness"),
        },
        "spot_finish": {
            "supported": False,
            "mask": None,
            "reason": "局部工艺必须绑定独立语义 mask，当前不支持",
        },
        "still": {
            "roughness": True,
            "coat": still_coat,
            "normal": still_normal,
            "ink_color_space": normalized.get("ink_color_space", "sRGB"),
            "normal_color_space": None if micro is None else micro["color_space"],
        },
        "glb_export": glb_export,
        "visual": {
            "substrate_rgba": list(normalized["substrate_rgba"]),
            "face_roughness": normalized["roughness"],
            "core_roughness": normalized.get("core_roughness", LEGACY_CORE_ROUGHNESS),
            "core_specular_ior_level": normalized.get(
                "core_specular_ior_level", LEGACY_CORE_SPECULAR_IOR
            ),
            "specular_ior_level": normalized["specular_ior_level"],
            "coat_weight": coat_weight,
            "coat_roughness": normalized.get("coat_roughness"),
            "face_use_coat": still_coat,
            "core_use_coat": False,
            "normal_strength": None if micro is None else micro["strength"],
            "micro_normal": deepcopy(micro) if micro is not None else None,
            "micro_normal_png": micro_png,
        },
    }


def blender_material_plan(layers: Mapping[str, Any]) -> dict[str, Any]:
    """Wiring contract for Blender.  Not proof of an exported GLB subset."""

    still = _mapping(layers.get("still"), "material.still")
    ink = _mapping(layers.get("ink"), "material.ink")
    visual = _mapping(layers.get("visual"), "material.visual")
    return {
        "ink_color_space": ink.get("color_space", "sRGB"),
        "normal_color_space": still.get("normal_color_space"),
        "alpha": ink.get("alpha", "MASK"),
        "core_opaque": True,
        "use_coat": bool(visual.get("face_use_coat", still.get("coat"))),
        "face_use_coat": bool(visual.get("face_use_coat", still.get("coat"))),
        "core_use_coat": False,
        "use_normal": bool(still.get("normal")),
        "face_roughness": visual.get("face_roughness"),
        "core_roughness": visual.get("core_roughness"),
        "coat_weight": visual.get("coat_weight"),
        "coat_roughness": visual.get("coat_roughness"),
        "normal_strength": visual.get("normal_strength"),
        "substrate_rgba": list(visual.get("substrate_rgba") or []),
        "specular_ior_level": visual.get("specular_ior_level"),
        "ink_specular_ior_level": visual.get("specular_ior_level"),
        "core_specular_ior_level": visual.get(
            "core_specular_ior_level", LEGACY_CORE_SPECULAR_IOR
        ),
        "micro_normal": deepcopy(visual.get("micro_normal")),
    }


def material_runtime_from_job(job: Mapping[str, Any]) -> dict[str, Any]:
    """Resolve material layers from a V2 spec or historical V1 flat render."""

    payload = _mapping(job, "job")
    spec = payload.get("render_spec")
    if spec is not None:
        material = _mapping(
            _mapping(spec, "render_spec").get("material"), "render_spec.material"
        )
        return resolved_material_layers(material)
    render = _mapping(payload.get("render"), "render")
    rgba = render.get("substrate_rgba", [0.7, 0.7, 0.7, 1.0])
    roughness = render.get("material_roughness", 0.52)
    specular = render.get("material_specular_ior", 0.08)
    return resolved_material_layers(
        {
            "substrate_profile": "white-card-default-v1",
            "print_layer": "process-ink-v1",
            "finish_profile": "none",
            "spot_finish_mask": None,
            "substrate_rgba": rgba,
            "roughness": roughness,
            "specular_ior_level": specular,
        }
    )


def _identity_from_spec(spec: Mapping[str, Any]) -> dict[str, str]:
    renderer = _mapping(spec.get("renderer"), "spec.renderer")
    identity = {
        "render_contract_hash": _hash_identity(
            spec.get("render_contract_hash"), "spec.render_contract_hash"
        ),
        "render_profile_id": _identifier(
            renderer.get("profile"), "spec.renderer.profile"
        ),
        "render_profile_sha256": _hash_identity(
            renderer.get("profile_sha256"), "spec.renderer.profile_sha256"
        ),
        "render_registry_sha256": _hash_identity(
            spec.get("registry_sha256"), "spec.registry_sha256"
        ),
    }
    return {key: identity[key] for key in RENDER_IDENTITY_KEYS}


def _plan_from_spec(spec: Mapping[str, Any]) -> dict[str, Any]:
    identity = _identity_from_spec(spec)
    sampling = dict(spec["sampling"])
    plan = {
        "schema": RENDER_PLAN_SCHEMA,
        "spec": dict(spec),
        "render": _renderer_config_from_normalized(spec),
        "sampling": sampling,
        "identity": identity,
        "fingerprint_token": canonical_sha256(identity),
    }
    if sampling.get("strategy") == PROJECTION_SAMPLING_STRATEGY:
        geometry = _mapping(spec.get("geometry"), "spec.geometry")
        shots = _mapping(spec.get("shots"), "spec.shots")
        plan["projection"] = _projection_report(
            geometry["outer_dimensions_mm"],
            shots,
            sampling,
        )
    return plan


def _assert_spec_bound_to_job(spec: Mapping[str, Any], job: Mapping[str, Any]) -> None:
    structure_job = _structure_job_from_legacy_resolved(job, require_assets=False)
    family, dimensions, structure_hash = _normalize_structure_job(structure_job)
    geometry = _mapping(spec.get("geometry"), "spec.geometry")
    if geometry.get("family") != family:
        _invalid(
            "render spec 与作业 family 不一致",
            field="spec.geometry.family",
            spec_family=geometry.get("family"),
            job_family=family,
        )
    if geometry.get("structure_hash") != structure_hash:
        _invalid(
            "render spec 与作业结构身份不一致",
            field="spec.geometry.structure_hash",
        )
    spec_dimensions = _normalize_dimensions(
        geometry.get("outer_dimensions_mm"), "spec.geometry.outer_dimensions_mm"
    )
    for axis in ("width", "depth", "height"):
        if spec_dimensions[axis] != dimensions[axis]:
            _invalid(
                "render spec 与作业尺寸不一致",
                field=f"spec.geometry.outer_dimensions_mm.{axis}",
                spec=spec_dimensions[axis],
                job=dimensions[axis],
            )


def _assert_job_identity_matches_spec(
    job: Mapping[str, Any], spec: Mapping[str, Any]
) -> None:
    expected = _identity_from_spec(spec)
    for key in RENDER_IDENTITY_KEYS:
        if key not in job:
            _invalid("作业缺少顶层渲染身份", field=key)
        actual = job.get(key)
        if actual != expected[key]:
            _invalid(
                "作业顶层渲染身份与 spec 不一致",
                field=key,
                expected=expected[key],
                actual=actual,
            )


def renderer_geometry_config(job: Mapping[str, Any]) -> dict[str, Any]:
    """Validate geometry identity before Blender mutates the scene.

    The private execution snapshot may legitimately adjust studio values. Only
    immutable geometry/spec identity is checked here; the pipeline owns its
    full execution-plan checks. Missing V2 specs never fall back to V1.
    """
    value = job.get("render_spec")
    if value is None:
        if (job.get("structure_schema") or job.get("structure_engine") == "v2"
                or job.get("schema") == RESOLVED_STRUCTURE_SCHEMA or job.get("packaging_family")
                or any(key in job for key in RENDER_IDENTITY_KEYS)):
            _invalid("V2 作业缺少 render_spec", field="render_spec")
        return {"family": "rectangular_carton_v1", "closure_detail": "legacy-closed-box-v0", "preview_fidelity": "legacy_box"}
    raw_geometry = _mapping(_mapping(value, "render_spec").get("geometry"), "spec.geometry")
    if raw_geometry.get("family") not in RENDER_FAMILIES:
        _fail("render_family_unsupported", "不支持的渲染 family", family=raw_geometry.get("family"))
    spec = validate_render_spec(value)
    _assert_spec_bound_to_job(spec, job)
    _assert_job_identity_matches_spec(job, spec)
    return dict(spec["geometry"])


def _assert_job_render_matches_spec(
    job: Mapping[str, Any], spec: Mapping[str, Any]
) -> None:
    derived = _renderer_config_from_normalized(spec)
    persisted = job.get("render")
    if not isinstance(persisted, Mapping):
        _invalid("作业缺少平面 render", field="render")
    render = _mapping(persisted, "job.render")
    extra = sorted(str(key) for key in render if key not in derived)
    if extra:
        _invalid("作业平面 render 含未知字段", field="job.render", unknown=extra)
    for key, expected in derived.items():
        if key not in render:
            _invalid("作业平面 render 缺少字段", field=f"job.render.{key}")
        actual = render.get(key)
        if key == "substrate_rgba":
            actual = _normalize_rgba(actual, f"job.render.{key}")
        elif key in {"resolution_x", "resolution_y"}:
            actual = _integer(actual, f"job.render.{key}", lower=1, upper=20_000)
        elif isinstance(expected, bool):
            actual = _boolean(actual, f"job.render.{key}")
        elif isinstance(expected, str):
            actual = _text(actual, f"job.render.{key}")
        else:
            actual = _number(actual, f"job.render.{key}")
        if actual != expected:
            _invalid(
                "作业平面 render 与 spec 派生值不一致",
                field=f"job.render.{key}",
                expected=expected,
                actual=actual,
            )


def _assert_legacy_synthesis_eligible(job: Mapping[str, Any]) -> None:
    version = job.get("pipeline_version")
    if version not in PRE_RF02_V2_PIPELINE_VERSIONS:
        _fail(
            "render_contract_invalid",
            "只有已知的 pre-RF02 V2 作业才能合成兼容合同",
            field="pipeline_version",
            pipeline_version=version,
        )
    if job.get("structure_engine") != "v2":
        _fail(
            "render_contract_invalid",
            "只有 V2 结构作业才能合成兼容合同",
            field="structure_engine",
            structure_engine=job.get("structure_engine"),
        )


def _assert_legacy_render_matches_compat(
    job: Mapping[str, Any], compat_render: Mapping[str, Any]
) -> None:
    persisted = job.get("render")
    if persisted is None or persisted == {}:
        _invalid("历史作业缺少可证明的渲染参数", field="legacy_job.render")
    render = _mapping(persisted, "legacy_job.render")
    missing = [key for key in LEGACY_RENDER_REQUIRED_KEYS if key not in render]
    if missing:
        _invalid(
            "历史作业渲染参数不完整",
            field="legacy_job.render",
            missing=missing,
        )
    for key in LEGACY_RENDER_COMPARE_KEYS:
        if key not in render:
            continue
        expected = compat_render.get(key)
        actual = render.get(key)
        if key == "substrate_rgba":
            actual = _normalize_rgba(actual, f"legacy_job.render.{key}")
        elif key in {
            "resolution_x",
            "resolution_y",
        }:
            actual = _integer(actual, f"legacy_job.render.{key}", lower=1, upper=20_000)
        elif key == "exact_white_background":
            actual = _boolean(actual, f"legacy_job.render.{key}")
        elif isinstance(expected, str):
            actual = _text(actual, f"legacy_job.render.{key}")
        else:
            actual = _number(actual, f"legacy_job.render.{key}")
        if actual != expected:
            _invalid(
                "历史作业渲染参数与 compat-legacy-v0 不一致，拒绝静默改画质",
                field=f"legacy_job.render.{key}",
                expected=expected,
                actual=actual,
            )


PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
BLENDER_RESULT_MEASUREMENT_KEYS = (
    "glb_dimensions_mm",
    "glb_dimension_error_mm",
    "glb_dimensions_mm_sorted",
    "glb_dimension_error_mm_sorted",
    "render_resolution",
    "blender_elapsed_s",
    "engine",
    "blender_version",
    "samples",
    "pixel_filter",
    "view_transform",
    "master_resolution_px",
    "face_sampling",
)
BLENDER_RESULT_ALLOWED_KEYS = frozenset(
    {"code", "outputs", "execution_nonce", "render_family", "preview_fidelity", "geometry_model", *BLENDER_RESULT_MEASUREMENT_KEYS}
)


def _canonical_path_text(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    return str(Path(text).expanduser().resolve())


def _path_identity_tokens(path: Path) -> frozenset[tuple[Any, ...]]:
    """Identify a path by casefold location and inode, following reserved symlinks.

    Output hardlinks and a reserved symlink's target must share an inode token.
    """

    tokens: set[tuple[Any, ...]] = set()
    target = Path(path).expanduser()
    tokens.add(("case", str(target).casefold()))
    try:
        tokens.add(("case", str(target.resolve()).casefold()))
    except OSError:
        pass
    try:
        link_stat = target.lstat()
    except OSError:
        return frozenset(tokens)
    link_ino = int(getattr(link_stat, "st_ino", 0) or 0)
    if link_ino:
        tokens.add(("ino", int(link_stat.st_dev), link_ino))
    try:
        followed = target.stat()
    except OSError:
        return frozenset(tokens)
    followed_ino = int(getattr(followed, "st_ino", 0) or 0)
    if followed_ino:
        tokens.add(("ino", int(followed.st_dev), followed_ino))
    return frozenset(tokens)


def _output_identity_token(path: Path) -> tuple[Any, ...]:
    tokens = _path_identity_tokens(path)
    for token in tokens:
        if token[0] == "ino":
            return token
    return next(iter(tokens))


def _identities_overlap(left: Path, right: Path) -> bool:
    return bool(_path_identity_tokens(left) & _path_identity_tokens(right))


def _is_regular_png(path: Path) -> bool:
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size <= 0:
            return False
        with path.open("rb") as handle:
            return handle.read(8).startswith(PNG_MAGIC)
    except OSError:
        return False


def _reserved_job_paths(job: Mapping[str, Any]) -> list[Path]:
    reserved: list[Path] = []
    for key in ("resolved_job_path", "source_ai", "template_path"):
        raw = job.get(key)
        if str(raw or "").strip():
            reserved.append(Path(str(raw)))
    assets = job.get("assets") if isinstance(job.get("assets"), Mapping) else {}
    for face in SEMANTIC_FACES:
        raw = assets.get(face)
        if str(raw or "").strip():
            reserved.append(Path(str(raw)))
    return reserved


def _bound_project_dir(
    job: Mapping[str, Any], project_dir: Path | str | None
) -> Path:
    raw = project_dir if project_dir is not None else job.get("project_dir")
    if not str(raw or "").strip():
        _invalid("作业缺少 project_dir", field="project_dir")
    return Path(str(raw)).expanduser().resolve()


def validate_job_output_contract(
    job: Mapping[str, Any],
    *,
    project_dir: Path | str | None = None,
) -> None:
    """Reject unknown, escaped, duplicate, or reserved renderer output targets.

    ``project_dir`` binds validation to this run's canonical product directory
    and must not be taken from a self-reported cached result when provided.
    """

    payload = _mapping(job, "resolved_job")
    bound_project = _bound_project_dir(payload, project_dir)
    outputs = _mapping(payload.get("outputs"), "outputs")
    unknown = sorted(str(key) for key in outputs if key not in ALLOWED_OUTPUT_KEYS)
    if unknown:
        _invalid(
            "渲染输出含未知 key",
            field="outputs",
            unknown=unknown,
            allowed=sorted(ALLOWED_OUTPUT_KEYS),
            writable=sorted(RENDERER_WRITABLE_OUTPUT_KEYS),
        )
    for key in REQUIRED_RENDERER_OUTPUT_KEYS:
        if not str(outputs.get(key) or "").strip():
            _invalid("这单没有可用成片路径，不能重渲棚。", field=f"outputs.{key}")
    reserved_paths = _reserved_job_paths(payload)
    seen: dict[str, frozenset[tuple[Any, ...]]] = {}
    for key, raw in outputs.items():
        if not str(raw or "").strip():
            continue
        path = Path(str(raw))
        try:
            is_link = path.is_symlink()
        except OSError as error:
            _invalid(
                "无法读取渲染输出路径",
                field=f"outputs.{key}",
                cause=str(error),
            )
        if is_link:
            _invalid("渲染输出路径不能是符号链接。", field=f"outputs.{key}")
        canonical = path.expanduser().resolve()
        try:
            canonical.relative_to(bound_project)
        except ValueError:
            _invalid("渲染输出必须落在本单目录内。", field=f"outputs.{key}")
        expected_suffix = OUTPUT_SUFFIX_BY_KEY.get(str(key))
        if expected_suffix and canonical.suffix.lower() != expected_suffix:
            _invalid(
                "渲染输出扩展名与 key 合同不一致",
                field=f"outputs.{key}",
                expected=expected_suffix,
                actual=canonical.suffix,
            )
        tokens = _path_identity_tokens(path)
        for other_key, other_tokens in seen.items():
            if tokens & other_tokens:
                _invalid(
                    "渲染输出路径不能重复。",
                    field=f"outputs.{key}",
                    other=other_key,
                )
        seen[str(key)] = tokens
        for reserved in reserved_paths:
            if _identities_overlap(path, reserved):
                _invalid("渲染输出不能覆盖保留输入。", field=f"outputs.{key}")


def validate_job_asset_contract(
    job: Mapping[str, Any],
    *,
    project_dir: Path | str | None = None,
) -> None:
    """Require the six semantic faces as unique in-tree regular PNG files."""

    payload = _mapping(job, "resolved_job")
    assets = _mapping(payload.get("assets"), "assets")
    extra = sorted(str(key) for key in assets if key not in SEMANTIC_FACES)
    if extra:
        _invalid("印刷面贴图含未知面", field="assets", unknown=extra)
    missing = [
        face for face in SEMANTIC_FACES if not str(assets.get(face) or "").strip()
    ]
    if missing:
        _invalid("印刷面贴图不完整", field="assets", missing=missing)
    bound_assets = None
    if project_dir is not None or str(payload.get("project_dir") or "").strip():
        bound_assets = _bound_project_dir(payload, project_dir) / "assets"
    seen: dict[str, frozenset[tuple[Any, ...]]] = {}
    for face in SEMANTIC_FACES:
        path = Path(str(assets[face]))
        try:
            is_link = path.is_symlink()
        except OSError as error:
            _invalid(
                "无法读取印刷面贴图",
                field=f"assets.{face}",
                cause=str(error),
            )
        if is_link:
            _invalid("印刷面贴图不能是符号链接。", field=f"assets.{face}")
        if not path.is_file():
            _invalid("印刷面贴图缺失", field=f"assets.{face}")
        if path.name != f"panel_{face}.png":
            _invalid(
                "印刷面贴图文件名与历史布局不一致",
                field=f"assets.{face}",
            )
        if path.parent.name != "assets":
            _invalid("印刷面贴图必须落在 assets 目录", field=f"assets.{face}")
        canonical = path.expanduser().resolve()
        if bound_assets is not None:
            try:
                canonical.relative_to(bound_assets)
            except ValueError:
                _invalid(
                    "印刷面贴图必须落在本单 assets 目录内",
                    field=f"assets.{face}",
                )
        if not _is_regular_png(path):
            _invalid("印刷面贴图必须是可读取的 PNG", field=f"assets.{face}")
        tokens = _path_identity_tokens(path)
        for other, other_tokens in seen.items():
            if tokens & other_tokens:
                _invalid(
                    "印刷面贴图不能重复。",
                    field=f"assets.{face}",
                    other=other,
                )
        seen[face] = tokens


def bind_persisted_job_to_project(
    previous: Mapping[str, Any],
    *,
    project_dir: Path | str,
    resolved_job_path: Path | str,
    code: str,
    slug: str,
    source_ai: Path | str | None = None,
    template_path: Path | str | None = None,
) -> None:
    """Reject a cached result that does not bind to this run's product paths."""

    payload = _mapping(previous, "cached_result")
    if str(payload.get("code") or "") != str(code):
        _invalid("缓存结果 code 与本单不一致", field="code")
    if str(payload.get("slug") or "") != str(slug):
        _invalid("缓存结果 slug 与本单不一致", field="slug")
    expected_project = Path(str(project_dir)).expanduser().resolve()
    declared_project = payload.get("project_dir")
    if (
        not str(declared_project or "").strip()
        or Path(str(declared_project)).expanduser().resolve() != expected_project
    ):
        _invalid("缓存结果 project_dir 与本单目录不一致", field="project_dir")
    expected_resolved = Path(str(resolved_job_path)).expanduser().resolve()
    declared_resolved = payload.get("resolved_job_path")
    if (
        not str(declared_resolved or "").strip()
        or Path(str(declared_resolved)).expanduser().resolve() != expected_resolved
    ):
        _invalid(
            "缓存结果 resolved_job_path 与本单作业文件不一致",
            field="resolved_job_path",
        )
    if source_ai is not None:
        declared_source = payload.get("source_ai")
        if _canonical_path_text(declared_source) != _canonical_path_text(source_ai):
            _invalid("缓存结果 source_ai 与本单源稿不一致", field="source_ai")
    if template_path is not None:
        declared_template = payload.get("template_path")
        if _canonical_path_text(declared_template) != _canonical_path_text(
            template_path
        ):
            _invalid(
                "缓存结果 template_path 与本单模板不一致",
                field="template_path",
            )


def apply_blender_result(
    blender_result: Mapping[str, Any],
    *,
    snapshot_job: Mapping[str, Any],
) -> dict[str, Any]:
    """Accept measurements and geometry labels bound to the execution contract."""

    result = _mapping(blender_result, "blender_result")
    unknown = sorted(
        str(key) for key in result if key not in BLENDER_RESULT_ALLOWED_KEYS
    )
    if unknown:
        _invalid(
            "Blender 结果含未知或受保护字段",
            field="blender_result",
            unknown=unknown,
        )
    snapshot = _mapping(snapshot_job, "execution_snapshot")
    if result.get("code") != snapshot.get("code"):
        _invalid(
            "Blender 结果 code 与执行快照不一致",
            field="blender_result.code",
            expected=snapshot.get("code"),
            actual=result.get("code"),
        )
    snapshot_outputs = _mapping(snapshot.get("outputs"), "execution_snapshot.outputs")
    result_outputs = _mapping(result.get("outputs"), "blender_result.outputs")
    if set(result_outputs) != set(snapshot_outputs):
        _invalid(
            "Blender 结果 outputs key 与执行快照不一致",
            field="blender_result.outputs",
            expected=sorted(snapshot_outputs),
            actual=sorted(result_outputs),
        )
    for key, raw in result_outputs.items():
        expected = snapshot_outputs.get(key)
        if _canonical_path_text(raw) != _canonical_path_text(expected):
            _invalid(
                "Blender 结果输出路径与执行快照不一致",
                field=f"blender_result.outputs.{key}",
            )
    expected_nonce = snapshot.get("execution_nonce")
    if not isinstance(expected_nonce, str) or not expected_nonce.strip():
        _invalid(
            "执行快照 execution_nonce 无效",
            field="execution_snapshot.execution_nonce",
        )
    if result.get("execution_nonce") != expected_nonce:
        _invalid(
            "Blender 结果不是本轮执行产物",
            field="blender_result.execution_nonce",
        )
    geometry_report = {}
    geometry_keys = {"render_family": "family", "preview_fidelity": "preview_fidelity", "geometry_model": "closure_detail"}
    geometry = snapshot.get("render_spec", {}).get("geometry", {})
    required = geometry.get("closure_detail") == "closed-carton-shell-v1" or geometry.get("family") == "pouch_thin_card_v1"
    if required or any(key in result for key in geometry_keys):
        trusted = renderer_geometry_config(snapshot)
        for key, source_key in geometry_keys.items():
            if result.get(key) != trusted[source_key]:
                _invalid("Blender 几何报告与本轮合同不一致", field=f"blender_result.{key}")
            geometry_report[key] = trusted[source_key]
    return {
        **geometry_report,
        **{
            key: deepcopy(result[key])
            for key in BLENDER_RESULT_MEASUREMENT_KEYS
            if key in result
        },
    }


def _consumed_job_view(job: Mapping[str, Any]) -> dict[str, Any]:
    assets = job.get("assets") if isinstance(job.get("assets"), Mapping) else {}
    outputs = job.get("outputs") if isinstance(job.get("outputs"), Mapping) else {}
    view: dict[str, Any] = {}
    for key in RENDERER_CONSUMED_JOB_KEYS:
        if key in {"source_ai", "template_path", "project_dir", "resolved_job_path"}:
            view[key] = _canonical_path_text(job.get(key))
        elif key == "assets":
            view[key] = {
                face: _canonical_path_text(assets.get(face)) for face in SEMANTIC_FACES
            }
        elif key == "outputs":
            view[key] = {
                str(name): _canonical_path_text(value) for name, value in outputs.items()
            }
        else:
            view[key] = job.get(key)
    return view


def _assert_renderer_consumed_jobs_equal(
    disk_job: Mapping[str, Any], memory_job: Mapping[str, Any]
) -> None:
    disk_view = _consumed_job_view(disk_job)
    memory_view = _consumed_job_view(memory_job)
    for key in disk_view:
        if disk_view[key] != memory_view[key]:
            _invalid(
                "磁盘作业与内存作业的渲染消费字段不一致",
                field=key,
            )


def _assert_execution_paths(
    disk_job: Mapping[str, Any],
    memory_job: Mapping[str, Any],
    resolved_job_path: Path | str,
) -> None:
    expected = Path(str(resolved_job_path)).expanduser().resolve()
    memory_path = Path(str(memory_job.get("resolved_job_path") or "")).expanduser()
    try:
        memory_resolved = memory_path.resolve()
    except OSError:
        memory_resolved = memory_path
    if memory_resolved != expected:
        _invalid(
            "内存作业 resolved_job_path 与将交给 Blender 的路径不一致",
            field="resolved_job_path",
        )
    declared = disk_job.get("resolved_job_path")
    if str(declared or "").strip():
        disk_path = Path(str(declared)).expanduser().resolve()
        if disk_path != expected:
            _invalid(
                "磁盘作业 resolved_job_path 与将交给 Blender 的路径不一致",
                field="resolved_job_path",
            )


def _strict_spec_bearing_plan(
    job: Mapping[str, Any], registry: Mapping[str, Any]
) -> dict[str, Any]:
    existing = job.get("render_spec")
    if existing is None:
        _invalid("Blender 执行要求作业带完整 render spec", field="render_spec")
    spec = _validate_render_spec_with_registry(existing, registry)
    _assert_spec_bound_to_job(spec, job)
    _assert_job_identity_matches_spec(job, spec)
    _assert_job_render_matches_spec(job, spec)
    return _plan_from_spec(spec)


def _plan_for_resolved_job_with_registry(
    resolved_job: Mapping[str, Any],
    output_request: Mapping[str, Any] | None,
    registry: Mapping[str, Any],
) -> dict[str, Any]:
    job = _mapping(resolved_job, "resolved_job")
    existing = job.get("render_spec")
    if existing is None:
        _assert_legacy_synthesis_eligible(job)
        spec = _synthesize_legacy_with_registry(job, output_request, registry)
    else:
        spec = _validate_render_spec_with_registry(existing, registry)
        _assert_spec_bound_to_job(spec, job)
        _assert_job_identity_matches_spec(job, spec)
        _assert_job_render_matches_spec(job, spec)
    return _plan_from_spec(spec)


def v1_diagnostic_render(template: Mapping[str, Any]) -> dict[str, Any]:
    """Historical V1/CLI render for registered templates.

    V2 templates must not grow a scattered ``render`` object.  Pipeline's
    non-V2 branch consumes this entry instead of copying registry internals.
    """

    payload = _mapping(template, "v1_template")
    if "render" in payload:
        render = _mapping(payload.get("render"), "v1_template.render")
        return deepcopy(dict(render))
    template_id = payload.get("template_id")
    if (
        not isinstance(template_id, str)
        or template_id not in V1_DIAGNOSTIC_RENDER_BY_TEMPLATE_ID
    ):
        _invalid(
            "非 V2 模板缺少历史渲染参数",
            field="v1_template.render",
            template_id=template_id,
        )
    return deepcopy(V1_DIAGNOSTIC_RENDER_BY_TEMPLATE_ID[template_id])


def persistable_plan_from_bound_job(job: Mapping[str, Any]) -> dict[str, Any]:
    """Rebuild a persistable plan from a job already accepted this process.

    Does not reread the registry.  Identity and flat render must still match
    the nested spec.
    """

    payload = _mapping(job, "resolved_job")
    spec = _mapping(payload.get("render_spec"), "job.render_spec")
    plan = _plan_from_spec(spec)
    _assert_job_identity_matches_spec(payload, spec)
    _assert_job_render_matches_spec(payload, spec)
    return plan


def render_plan_for_new_job(
    structure_job: Mapping[str, Any],
    profile_id: str,
    output_request: Mapping[str, Any] | None = None,
    *,
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
) -> dict[str, Any]:
    """Resolve a persistable render plan for a new V2 task.

    Pipeline must consume this object: spec, flat render, sampling, top-level
    identity, and fingerprint_token.  It must not read the registry or copy
    nested hash field names.
    """

    plan, _cached = render_plan_for_new_job_and_persisted_result(
        structure_job,
        profile_id,
        output_request,
        None,
        registry_path=registry_path,
    )
    return plan


def render_plan_for_new_job_and_persisted_result(
    structure_job: Mapping[str, Any],
    profile_id: str,
    output_request: Mapping[str, Any] | None,
    persisted_result: Mapping[str, Any] | None,
    *,
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """One registry snapshot for the new-job plus optional cached-result boundary."""

    registry = load_profile_registry(registry_path)
    spec = _resolve_render_spec_with_registry(
        structure_job, profile_id, output_request, registry
    )
    plan = _plan_from_spec(spec)
    cached: dict[str, Any] | None = None
    if persisted_result is not None:
        try:
            cached = _plan_for_resolved_job_with_registry(
                persisted_result, None, registry
            )
        except RenderContractError:
            cached = None
    return plan, cached


def render_plan_for_resolved_job(
    resolved_job: Mapping[str, Any],
    output_request: Mapping[str, Any] | None = None,
    *,
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
) -> dict[str, Any]:
    """Validate or synthesize a persistable plan for an existing resolved job.

    Complete specs are rebound to this job's structure facts.  Missing specs
    synthesize ``compat-legacy-v0`` only for known pre-RF02 V2 jobs.
    """

    registry = load_profile_registry(registry_path)
    return _plan_for_resolved_job_with_registry(
        resolved_job, output_request, registry
    )


def blender_execution_plan(
    disk_job: Mapping[str, Any],
    memory_job: Mapping[str, Any],
    *,
    resolved_job_path: Path | str,
    registry_path: Path | str = DEFAULT_REGISTRY_PATH,
    asset_project_dir: Path | str | None = None,
) -> dict[str, Any]:
    """Validate the disk payload Blender will read against the in-memory job.

    One registry snapshot.  Spec-bearing RF-02 jobs must have all four top-level
    identity fields, a flat render equal to the spec-derived config, and
    in-tree output targets.  Any disk/memory difference fails before subprocess.
    Disk/memory equality does not make illegal asset or output paths legal.

    Asset authorization is the actual execution ``project_dir``, or a
    caller-verified ``asset_project_dir`` (relight).  Never infer the root
    from the payload's own asset paths.
    """

    registry = load_profile_registry(registry_path)
    disk = _mapping(disk_job, "disk_job")
    memory = _mapping(memory_job, "memory_job")
    disk_plan = _strict_spec_bearing_plan(disk, registry)
    memory_plan = _strict_spec_bearing_plan(memory, registry)
    if disk_plan["fingerprint_token"] != memory_plan["fingerprint_token"]:
        _invalid(
            "磁盘作业合同与内存作业合同不一致",
            field="fingerprint_token",
        )
    _assert_execution_paths(disk, memory, resolved_job_path)
    _assert_renderer_consumed_jobs_equal(disk, memory)
    execution_project = _bound_project_dir(disk, None)
    validate_job_output_contract(disk, project_dir=execution_project)
    if asset_project_dir is not None:
        asset_project = Path(str(asset_project_dir)).expanduser().resolve()
    else:
        asset_project = execution_project
    validate_job_asset_contract(disk, project_dir=asset_project)
    validate_job_asset_contract(memory, project_dir=asset_project)
    return disk_plan
