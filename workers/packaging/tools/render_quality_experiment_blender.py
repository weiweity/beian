#!/usr/bin/env python3
"""RF-E02 experimental Blender wrapper.

Loaded as pipeline.BLENDER_SCRIPT only while the experiment driver runs.
Importing this module must not create directories, call Blender, change the
environment, or write results. bpy is imported only inside the Blender process.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
from typing import Any


PACKAGING_ROOT = Path(__file__).resolve().parents[1]
RENDER_JOB_PATH = PACKAGING_ROOT / "blender" / "render_job.py"
CAMERA_FRAME_PATH = PACKAGING_ROOT / "camera_frame.py"
DECLARATION_PATH = (
    PACKAGING_ROOT / "fixtures" / "render-quality" / "experiments" / "rfe02-lighting.json"
)
ENV_JOB = "BEIAN_RFE02_JOB"
VARIANT_CONTROL = "control"
VARIANT_NORMALIZED = "normalized-rig-v1"
VARIANTS = (VARIANT_CONTROL, VARIANT_NORMALIZED)
REFERENCE_LONGEST_MM = 180.0
REFERENCE_TARGET_MM = (0.0, 0.0, 90.0)
LIGHT_ORDER = ("Key softbox", "Fill softbox", "Rim softbox")
SHAPES_WITH_SIZE_Y = {"RECTANGLE", "ELLIPSE"}
REQUIRED_STILL_KEYS = (
    "front_right",
    "back_left",
    "front_right_ground",
    "back_left_ground",
    "front_right_set",
    "back_left_set",
)
NOT_ASSESSED = "not_assessed"
JOB_RECEIPT_NAME = "rfe02-job-receipt.json"
PASS_RECEIPT_NAME = "rfe02-pass-receipts.json"
ENVELOPE_SCHEMA = "beian-rfe02-job-envelope/1"
PASS_SCHEMA = "beian-rfe02-pass-receipt/1"
JOB_SCHEMA = "beian-rfe02-job-receipt/1"
SHA256_RE = r"^[0-9a-f]{64}$"


class ExperimentError(RuntimeError):
    pass


def canonical_dumps(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def measured(value: Any, unit: str | None, method: str) -> dict[str, Any]:
    payload: dict[str, Any] = {"status": "measured", "value": value, "method": method}
    if unit is not None:
        payload["unit"] = unit
    return payload


def unavailable(reason: str, *, unit: str | None = None, method: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"status": "unavailable", "reason": reason}
    if unit is not None:
        payload["unit"] = unit
    if method is not None:
        payload["method"] = method
    return payload


def _finite_positive(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    number = float(value)
    return math.isfinite(number) and number > 0.0


def validate_dimensions(dimensions: Any) -> tuple[float, float, float]:
    if not isinstance(dimensions, Mapping):
        raise ExperimentError("dimensions_mm must be an object")
    missing = [key for key in ("width", "depth", "height") if key not in dimensions]
    if missing:
        raise ExperimentError(f"dimensions_mm missing {missing}")
    values = []
    for key in ("width", "depth", "height"):
        raw = dimensions[key]
        if not _finite_positive(raw):
            raise ExperimentError(f"dimensions_mm.{key} must be a finite positive number")
        values.append(float(raw))
    return values[0], values[1], values[2]


def scale_factor(width: float, depth: float, height: float) -> float:
    longest = max(width, depth, height)
    return longest / REFERENCE_LONGEST_MM


def target_from_height(height: float) -> tuple[float, float, float]:
    return (0.0, 0.0, height / 2.0)


def transform_location(
    location: Sequence[float],
    scale: float,
    target: Sequence[float],
) -> tuple[float, float, float]:
    if len(location) != 3 or len(target) != 3:
        raise ExperimentError("location and target must be 3-vectors")
    px, py, pz = (float(location[0]), float(location[1]), float(location[2]))
    tx, ty, tz = (float(target[0]), float(target[1]), float(target[2]))
    rx, ry, rz = REFERENCE_TARGET_MM
    return (
        tx + scale * (px - rx),
        ty + scale * (py - ry),
        tz + scale * (pz - rz),
    )


def transform_size(size: float, scale: float) -> float:
    if isinstance(size, bool) or not isinstance(size, (int, float)) or not math.isfinite(float(size)):
        raise ExperimentError("light size must be a finite number")
    return float(size) * scale


def transform_energy(energy: float, scale: float) -> float:
    if isinstance(energy, bool) or not isinstance(energy, (int, float)) or not math.isfinite(float(energy)):
        raise ExperimentError("light energy must be a finite number")
    return float(energy) * scale * scale


def shape_uses_size_y(shape: Any) -> bool:
    return str(shape) in SHAPES_WITH_SIZE_Y


def validate_variant(variant: Any) -> str:
    if variant not in VARIANTS:
        raise ExperimentError(f"unsupported lighting variant: {variant!r}")
    return str(variant)


def _light_name(light: Any) -> str:
    return str(getattr(light, "name", "") or "")


def _light_data(light: Any) -> Any:
    return getattr(light, "data", None)


def _light_type(light: Any) -> str | None:
    data = _light_data(light)
    if data is None:
        return None
    raw = getattr(data, "type", None)
    return None if raw is None else str(raw)


def studio_lights_by_name(lights: Sequence[Any]) -> dict[str, Any]:
    named = {}
    for light in lights:
        name = _light_name(light)
        if name in named:
            raise ExperimentError(f"duplicate studio light name: {name}")
        named[name] = light
    return named


def validate_studio_lights(lights: Sequence[Any]) -> dict[str, Any]:
    if len(lights) != 3:
        raise ExperimentError("studio must have exactly three lights")
    named = studio_lights_by_name(lights)
    if set(named) != set(LIGHT_ORDER):
        raise ExperimentError("studio lights must be Key/Fill/Rim softbox")
    for name in LIGHT_ORDER:
        light_type = _light_type(named[name])
        if light_type != "AREA":
            raise ExperimentError(f"{name} must be AREA, got {light_type!r}")
    return named


def candidate_light_params(
    dimensions: Mapping[str, Any],
    lights: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Pure expected B parameters from actual control light dicts. No color routing."""
    width, depth, height = validate_dimensions(dimensions)
    scale = scale_factor(width, depth, height)
    target = target_from_height(height)
    objects = []
    for item in lights:
        if not isinstance(item, Mapping):
            raise ExperimentError("light snapshot must be an object")
        objects.append(_DictLight(item))
    named = validate_studio_lights(objects)
    result = []
    for name in LIGHT_ORDER:
        light = named[name]
        data = light.data
        size_y = None
        if shape_uses_size_y(data.shape) and getattr(data, "size_y", None) is not None:
            size_y = transform_size(float(data.size_y), scale)
        result.append(
            {
                "name": name,
                "location": list(transform_location(light.location, scale, target)),
                "type": "AREA",
                "shape": None if data.shape is None else str(data.shape),
                "size": transform_size(float(data.size), scale),
                "size_y": size_y,
                "energy": transform_energy(float(data.energy), scale),
                "color": list(data.color) if data.color is not None else None,
                "look_at": list(target),
                "scale": scale,
            }
        )
    return result


def apply_normalized_rig(
    lights: Sequence[Any],
    dimensions: Mapping[str, Any],
    look_at: Callable[[Any, Sequence[float]], None],
) -> dict[str, Any]:
    named = validate_studio_lights(lights)
    width, depth, height = validate_dimensions(dimensions)
    scale = scale_factor(width, depth, height)
    target = target_from_height(height)
    for name in LIGHT_ORDER:
        light = named[name]
        data = _light_data(light)
        location = _as_vec3(getattr(light, "location", None), label=f"{name}.location")
        light.location = transform_location(location, scale, target)
        data.size = transform_size(float(data.size), scale)
        if shape_uses_size_y(getattr(data, "shape", None)) and hasattr(data, "size_y"):
            data.size_y = transform_size(float(data.size_y), scale)
        data.energy = transform_energy(float(data.energy), scale)
        look_at(light, target)
    return {"scale": scale, "target": list(target)}


def lights_are_identity(control: Sequence[Mapping[str, Any]], candidate: Sequence[Mapping[str, Any]]) -> bool:
    if len(control) != len(candidate):
        return False
    for left, right in zip(control, candidate):
        if left.get("name") != right.get("name"):
            return False
        if not _vec_close(left.get("location"), right.get("location")):
            return False
        if not _num_close(left.get("size"), right.get("size")):
            return False
        left_y = left.get("size_y")
        right_y = right.get("size_y")
        if (left_y is None) != (right_y is None):
            return False
        if left_y is not None and not _num_close(left_y, right_y):
            return False
        if not _num_close(left.get("energy"), right.get("energy")):
            return False
    return True


def snapshot_light_state(light: Any) -> dict[str, Any]:
    data = _light_data(light)
    shape = getattr(data, "shape", None) if data is not None else None
    size_y_value = getattr(data, "size_y", None) if data is not None else None
    if data is None:
        size_y: Any = unavailable("light_data_missing", method="light.data")
    elif not shape_uses_size_y(shape):
        size_y = unavailable("size_y_not_applicable_for_shape", method="light.data.shape")
    elif size_y_value is None:
        size_y = unavailable("size_y_missing", method="light.data.size_y")
    else:
        try:
            size_y = measured(float(size_y_value), "mm", "light.data.size_y")
        except (TypeError, ValueError):
            size_y = unavailable("size_y_unreadable", method="light.data.size_y")
    return {
        "name": _light_name(light),
        "location": _read_vec3(getattr(light, "location", None), "object.location"),
        "rotation_euler": _read_vec3(getattr(light, "rotation_euler", None), "object.rotation_euler"),
        "type": _read_scalar(_light_type(light), "light.data.type"),
        "shape": _read_scalar(None if shape is None else str(shape), "light.data.shape"),
        "size": _read_float(getattr(data, "size", None) if data is not None else None, "light.data.size"),
        "size_y": size_y,
        "energy": _read_float(getattr(data, "energy", None) if data is not None else None, "light.data.energy"),
        "color": _read_color(getattr(data, "color", None) if data is not None else None, "light.data.color"),
    }


def capture_world(scene: Any) -> Any:
    world = getattr(scene, "world", None)
    if world is None:
        return unavailable("world_missing", method="scene.world")
    color = getattr(world, "color", None)
    use_nodes = getattr(world, "use_nodes", None)
    background: Any
    try:
        nodes = world.node_tree.nodes
        bg = None
        for node in nodes:
            if str(getattr(node, "type", "")) == "BACKGROUND":
                bg = node
                break
        if bg is None:
            background = unavailable("world_background_node_missing", method="world.node_tree.nodes")
        else:
            bg_color = bg.inputs["Color"].default_value
            strength = bg.inputs["Strength"].default_value
            background = {
                "color": _as_float_list(bg_color, 4, "world background color"),
                "strength": float(strength),
            }
    except Exception as error:
        background = unavailable(
            f"world_background_unreadable:{type(error).__name__}",
            method="ShaderNodeBackground",
        )
    return {
        "color": _read_color(color, "world.color"),
        "use_nodes": use_nodes if isinstance(use_nodes, bool) else unavailable("world_use_nodes_unreadable"),
        "background": background,
    }


def capture_camera(scene: Any) -> Any:
    camera = getattr(scene, "camera", None)
    if camera is None:
        return unavailable("camera_missing", method="scene.camera")
    data = getattr(camera, "data", None)
    return {
        "matrix_world": _read_matrix(getattr(camera, "matrix_world", None), "camera.matrix_world"),
        "type": _read_scalar(getattr(data, "type", None) if data is not None else None, "camera.data.type"),
        "ortho_scale": _read_float(
            getattr(data, "ortho_scale", None) if data is not None else None,
            "camera.data.ortho_scale",
        ),
    }


def capture_engine(scene: Any) -> dict[str, Any]:
    render = getattr(scene, "render", None)
    engine = getattr(render, "engine", None) if render is not None else None
    if engine is None:
        engine_payload: Any = unavailable("render_engine_missing", method="scene.render.engine")
    else:
        engine_payload = measured(str(engine), None, "scene.render.engine")
    samples = unavailable("engine_sample_field_missing", unit="1", method="scene.eevee taa_*")
    eevee = getattr(scene, "eevee", None)
    if eevee is None:
        samples = unavailable("scene_eevee_missing", unit="1", method="scene.eevee")
    else:
        for name in ("taa_render_samples", "taa_samples", "samples"):
            if hasattr(eevee, name):
                raw = getattr(eevee, name)
                try:
                    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(float(raw)):
                        samples = unavailable(
                            f"engine_sample_unreadable:{name}",
                            unit="1",
                            method=f"scene.eevee.{name}",
                        )
                    else:
                        samples = measured(raw, "1", f"scene.eevee.{name}")
                except (TypeError, ValueError):
                    samples = unavailable(
                        f"engine_sample_unreadable:{name}",
                        unit="1",
                        method=f"scene.eevee.{name}",
                    )
                break
    return {"engine": engine_payload, "samples": samples}


def capture_render_settings(scene: Any) -> dict[str, Any]:
    render = getattr(scene, "render", None)
    image = getattr(render, "image_settings", None) if render is not None else None
    view = getattr(scene, "view_settings", None)
    return {
        "resolution_x": _read_int(getattr(render, "resolution_x", None) if render is not None else None, "scene.render.resolution_x"),
        "resolution_y": _read_int(getattr(render, "resolution_y", None) if render is not None else None, "scene.render.resolution_y"),
        "resolution_percentage": _read_int(
            getattr(render, "resolution_percentage", None) if render is not None else None,
            "scene.render.resolution_percentage",
        ),
        "film_transparent": _read_bool(
            getattr(render, "film_transparent", None) if render is not None else None,
            "scene.render.film_transparent",
        ),
        "color_depth": _read_scalar(getattr(image, "color_depth", None) if image is not None else None, "image_settings.color_depth"),
        "color_mode": _read_scalar(getattr(image, "color_mode", None) if image is not None else None, "image_settings.color_mode"),
        "view_transform": _read_scalar(getattr(view, "view_transform", None) if view is not None else None, "view_settings.view_transform"),
        "look": _read_scalar(getattr(view, "look", None) if view is not None else None, "view_settings.look"),
        "exposure": _read_float(getattr(view, "exposure", None) if view is not None else None, "view_settings.exposure"),
        "gamma": _read_float(getattr(view, "gamma", None) if view is not None else None, "view_settings.gamma"),
    }


def capture_object(scene: Any, job: Mapping[str, Any] | None) -> dict[str, Any]:
    objects = _scene_objects(scene)
    root = _find_named(objects, "_Model_Root")
    core = _find_named(objects, "_Box_Core")
    yaw = unavailable("model_root_missing", method="root.rotation_euler.z")
    if root is not None:
        rotation = getattr(root, "rotation_euler", None)
        yaw = _read_float(rotation[2] if rotation is not None else None, "root.rotation_euler.z")
    transform = unavailable("model_root_missing", method="root.matrix_world")
    if root is not None:
        transform = _read_matrix(getattr(root, "matrix_world", None), "root.matrix_world")
    geometry = unavailable("box_core_missing", method="core mesh summary")
    if core is not None:
        geometry = {
            "name": getattr(core, "name", None),
            "dimensions": _read_vec3(getattr(core, "dimensions", None), "core.dimensions"),
            "vertex_count": _mesh_vertex_count(core),
        }
    materials = []
    texture_identities = []
    for obj in objects:
        for material in _object_materials(obj):
            materials.append(_capture_material(material))
            texture_identities.extend(_texture_identities(material))
    assets = job.get("assets") if isinstance(job, Mapping) else None
    if isinstance(assets, Mapping):
        for face, raw in sorted(assets.items()):
            path = Path(str(raw))
            if path.is_file():
                texture_identities.append(
                    {
                        "face": face,
                        "path_name": path.name,
                        "sha256": sha256_file(path),
                    }
                )
    return {
        "yaw": yaw,
        "transform": transform,
        "geometry": geometry,
        "materials": materials,
        "textures": texture_identities,
    }


def capture_pass_scene(
    scene: Any,
    *,
    path: str | Path,
    job: Mapping[str, Any],
    lights: Sequence[Any],
    variant: str,
    declaration_sha256: str,
    snapshot_sha256: str,
    source_identity: Mapping[str, Any],
) -> dict[str, Any]:
    output_key = output_key_for_path(job, path)
    try:
        light_states = [snapshot_light_state(light) for light in ordered_lights(lights)]
        lights_ok = True
    except ExperimentError as error:
        light_states = [{"status": "unavailable", "reason": str(error)}]
        lights_ok = False
    receipt = {
        "schema": PASS_SCHEMA,
        "experimental_scene_override": variant == VARIANT_NORMALIZED,
        "variant": variant,
        "execution_nonce": job.get("execution_nonce"),
        "declaration_sha256": declaration_sha256,
        "snapshot_sha256": snapshot_sha256,
        "source_identity": dict(source_identity),
        "output_key": output_key,
        "output_path_name": Path(path).name,
        "lights": light_states,
        "world": capture_world(scene),
        "camera": capture_camera(scene),
        "object": capture_object(scene, job),
        "engine": capture_engine(scene),
        "render": capture_render_settings(scene),
        "pass_complete": False,
        "output_sha256": None,
        "lights_contract_ok": lights_ok,
    }
    return receipt


def ordered_lights(lights: Sequence[Any]) -> list[Any]:
    named = validate_studio_lights(lights)
    return [named[name] for name in LIGHT_ORDER]


def output_key_for_path(job: Mapping[str, Any], path: str | Path) -> str | None:
    outputs = job.get("outputs")
    if not isinstance(outputs, Mapping):
        return None
    try:
        resolved = Path(path).expanduser().resolve(strict=False)
    except OSError:
        return None
    for key, raw in outputs.items():
        try:
            if Path(str(raw)).expanduser().resolve(strict=False) == resolved:
                return str(key)
        except OSError:
            continue
    return None


def valid_sha256(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


def valid_source_identity(value: Any) -> bool:
    return (isinstance(value, Mapping) and
            all(valid_sha256(value.get(key)) for key in
                ('wrapper_sha256', 'render_job_sha256', 'camera_frame_sha256', 'glb_verify_sha256')))


def _finite_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return True
    if isinstance(value, (int, float)):
        return math.isfinite(value)
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple)):
        return bool(value) and all(_finite_value(item) for item in value)
    return False


def _metric_valid(payload: Any) -> bool:
    return (isinstance(payload, Mapping) and payload.get('status') == 'measured'
            and _finite_value(payload.get('value')) and bool(payload.get('method')))


def _metric_fields(payload: Any, fields: Sequence[str]) -> bool:
    return isinstance(payload, Mapping) and all(_metric_valid(payload.get(key)) for key in fields)


def _positive_metric(payload: Any) -> bool:
    return (_metric_valid(payload) and _finite_positive(payload['value']))


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _vector(value: Any, size: int) -> bool:
    return isinstance(value, (list, tuple)) and len(value) == size and all(_number(x) for x in value)


def _matrix(value: Any) -> bool:
    return isinstance(value, (list, tuple)) and len(value) == 4 and all(_vector(row, 4) for row in value)


def pass_evidence_incomplete(receipt: Mapping[str, Any]) -> bool:
    # Positive validation: an absent field is NOT evidence that a measurement exists.
    if not isinstance(receipt, Mapping):
        return True
    if (receipt.get('variant') not in (VARIANT_CONTROL, VARIANT_NORMALIZED)
            or not valid_sha256(receipt.get('declaration_sha256'))
            or not valid_sha256(receipt.get('snapshot_sha256'))
            or not valid_source_identity(receipt.get('source_identity'))
            or receipt.get('output_key') not in REQUIRED_STILL_KEYS):
        return True
    lights = receipt.get('lights')
    if not isinstance(lights, list) or len(lights) != 3:
        return True
    if any(not isinstance(light, Mapping) for light in lights):
        return True
    if sorted(light.get('name', '') for light in lights) != sorted(LIGHT_ORDER):
        return True
    for light in lights:
        if not _metric_fields(light, ('location', 'rotation_euler', 'type', 'shape', 'size', 'energy', 'color')):
            return True
        if light['type']['value'] != 'AREA' or not _positive_metric(light['size']) or not _positive_metric(light['energy']):
            return True
        if any(not _vector(light[field]['value'], 3) for field in ('location', 'rotation_euler', 'color')):
            return True
        if shape_uses_size_y(light['shape']['value']) and not _positive_metric(light.get('size_y')):
            return True
    camera = receipt.get('camera')
    if not _metric_fields(camera, ('matrix_world', 'type', 'ortho_scale')):
        return True
    if not _positive_metric(camera['ortho_scale']):
        return True
    if not _matrix(camera['matrix_world']['value']) or camera['type']['value'] != 'ORTHO':
        return True
    world = receipt.get('world')
    if not isinstance(world, Mapping) or not _metric_valid(world.get('color')) or world.get('use_nodes') is not True:
        return True
    background = world.get('background')
    if (not isinstance(background, Mapping) or not _vector(background.get('color'), 4)
            or not isinstance(background.get('strength'), (int, float))
            or isinstance(background.get('strength'), bool) or not math.isfinite(background['strength'])):
        return True
    engine = receipt.get('engine')
    if not _metric_fields(engine, ('engine', 'samples')) or not _positive_metric(engine['samples']):
        return True
    obj = receipt.get('object')
    if not _metric_fields(obj, ('yaw', 'transform')):
        return True
    if not _number(obj['yaw']['value']) or not _matrix(obj['transform']['value']):
        return True
    if not _metric_fields(obj.get('geometry'), ('dimensions', 'vertex_count')):
        return True
    if (not _vector(obj['geometry']['dimensions']['value'], 3)
            or not _positive_metric(obj['geometry']['vertex_count'])):
        return True
    materials, textures = obj.get('materials'), obj.get('textures')
    if not isinstance(materials, list) or not materials or any(
            not _metric_fields(mat, ('roughness', 'base_color')) for mat in materials):
        return True
    if any(not _number(mat['roughness']['value']) or not _vector(mat['base_color']['value'], 4) for mat in materials):
        return True
    if not isinstance(textures, list) or not textures or any(
            not isinstance(tex, Mapping) or not valid_sha256(tex.get('sha256')) for tex in textures):
        return True
    required = (
        "execution_nonce",
        "declaration_sha256",
        "snapshot_sha256",
        "variant",
        "output_key",
        "lights",
        "world",
        "camera",
        "object",
        "engine",
        "render",
    )
    for key in required:
        if receipt.get(key) in (None, "", []):
            return True
    if receipt.get("output_key") not in REQUIRED_STILL_KEYS and receipt.get("output_key") is not None:
        # blend/glb are not still passes
        return False
    if receipt.get("lights_contract_ok") is not True:
        return True
    if _payload_unavailable(receipt.get("world")):
        return True
    if _payload_unavailable(receipt.get("camera")):
        return True
    engine = receipt.get("engine")
    if not isinstance(engine, Mapping) or _payload_unavailable(engine.get("engine")):
        return True
    render = receipt.get("render")
    if not isinstance(render, Mapping):
        return True
    for field in (
        "resolution_x",
        "resolution_y",
        "resolution_percentage",
        "film_transparent",
        "color_depth",
        "color_mode",
        "view_transform",
        "look",
        "exposure",
        "gamma",
    ):
        if not _metric_valid(render.get(field)):
            return True
    for field in ('resolution_x', 'resolution_y', 'resolution_percentage'):
        if not _positive_metric(render[field]) or not isinstance(render[field]['value'], int):
            return True
    if not isinstance(render['film_transparent']['value'], bool):
        return True
    if any(not _number(render[field]['value']) for field in ('exposure', 'gamma')):
        return True
    obj = receipt.get("object")
    if not isinstance(obj, Mapping) or _payload_unavailable(obj.get("yaw")):
        return True
    nonce = receipt.get("execution_nonce")
    if not isinstance(nonce, str) or not nonce.strip():
        return True
    return False


def finalize_job_receipt(
    *,
    main_finished: bool,
    variant: str,
    declaration_sha256: str,
    snapshot_sha256: str,
    source_identity: Mapping[str, Any],
    passes: Sequence[Mapping[str, Any]],
    blender_result: Mapping[str, Any] | None,
    expected_nonce: Any,
    outputs: Mapping[str, Any] | None,
) -> dict[str, Any]:
    evidence_insufficient = not (
        variant in (VARIANT_CONTROL, VARIANT_NORMALIZED)
        and valid_sha256(declaration_sha256) and valid_sha256(snapshot_sha256)
        and valid_source_identity(source_identity)
    )
    expected_identity = dict(execution_nonce=expected_nonce, variant=variant,
                             declaration_sha256=declaration_sha256, snapshot_sha256=snapshot_sha256,
                             source_identity=source_identity)
    required_passes: dict[str, Mapping[str, Any]] = {}
    for item in passes:
        if not isinstance(item, Mapping):
            evidence_insufficient = True
            continue
        key = item.get("output_key")
        if key in REQUIRED_STILL_KEYS:
            if key in required_passes:
                evidence_insufficient = True
            required_passes[str(key)] = item
        if any(item.get(field) != value for field, value in expected_identity.items()):
            evidence_insufficient = True
        if pass_evidence_incomplete(item):
            evidence_insufficient = True
    missing_keys = [key for key in REQUIRED_STILL_KEYS if key not in required_passes]
    if missing_keys:
        evidence_insufficient = True
    outputs_closed = True
    output_hashes: dict[str, Any] = {}
    if not isinstance(outputs, Mapping):
        outputs_closed = False
    else:
        for key in REQUIRED_STILL_KEYS:
            raw = outputs.get(key)
            path = Path(str(raw)) if raw else None
            if path is None or not path.is_file():
                outputs_closed = False
                output_hashes[key] = unavailable("required_pass_file_missing", method="Path.is_file")
                continue
            digest = sha256_file(path)
            output_hashes[key] = measured(digest, None, "SHA-256 of still file")
            receipt = required_passes.get(key)
            if receipt is None or receipt.get("output_sha256") != digest or receipt.get("pass_complete") is not True:
                outputs_closed = False
    result_nonce = None if not isinstance(blender_result, Mapping) else blender_result.get("execution_nonce")
    nonce_ok = (
        main_finished
        and isinstance(expected_nonce, str)
        and bool(expected_nonce.strip())
        and result_nonce == expected_nonce
    )
    if isinstance(expected_nonce, str) and isinstance(result_nonce, str) and result_nonce != expected_nonce:
        nonce_ok = False
    complete = (
        main_finished
        and nonce_ok
        and outputs_closed
        and not evidence_insufficient
        and not missing_keys
        and all(required_passes[key].get("pass_complete") is True for key in REQUIRED_STILL_KEYS if key in required_passes)
    )
    return {
        "schema": JOB_SCHEMA,
        "experimental_scene_override": variant == VARIANT_NORMALIZED,
        "variant": variant,
        "product_default_semantics": VARIANT_CONTROL,
        "candidate_is_product_profile": False,
        "complete": complete,
        "main_finished": main_finished,
        "nonce_ok": nonce_ok,
        "outputs_closed": outputs_closed,
        "evidence_insufficient": evidence_insufficient,
        "missing_required_passes": missing_keys,
        "declaration_sha256": declaration_sha256,
        "snapshot_sha256": snapshot_sha256,
        "source_identity": dict(source_identity),
        "execution_nonce": expected_nonce,
        "blender_result_nonce": result_nonce,
        "output_sha256": output_hashes,
        "passes": list(passes),
        "quality_improvement": NOT_ASSESSED,
        "human_review": NOT_ASSESSED,
        "windows": NOT_ASSESSED,
        "l2": NOT_ASSESSED,
        "browser": {"status": "not_measured", "reason": "deferred_to_e02_c"},
        "font_mapping": {"status": "not_measured", "reason": "unknown_browser_font_mapping"},
    }


def source_identity_payload() -> dict[str, str]:
    return {
        "wrapper_sha256": sha256_file(Path(__file__).resolve()),
        "render_job_sha256": sha256_file(RENDER_JOB_PATH),
        "camera_frame_sha256": sha256_file(CAMERA_FRAME_PATH),
        "glb_verify_sha256": sha256_file(RENDER_JOB_PATH.parent.parent / "glb_verify.py"),
    }


def load_envelope(path: Path) -> dict[str, Any]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("schema") != ENVELOPE_SCHEMA:
        raise ExperimentError("invalid RF-E02 job envelope")
    validate_variant(payload.get("variant"))
    return payload


def make_add_studio(
    original: Callable[[Mapping[str, Any]], Any],
    ctx: "ExperimentContext",
) -> Callable[[Mapping[str, Any]], Any]:
    def wrapped(job: Mapping[str, Any]) -> Any:
        ctx.add_studio_calls += 1
        ctx.job = job
        camera = original(job)
        lights = ctx.list_lights()
        ctx.lights_after_original = [snapshot_light_state(light) for light in lights]
        variant = ctx.variant
        if variant == VARIANT_CONTROL:
            return camera
        if variant == VARIANT_NORMALIZED:
            apply_normalized_rig(lights, job["dimensions_mm"], ctx.look_at)
            ctx.lights_after_candidate = [snapshot_light_state(light) for light in ctx.list_lights()]
            return camera
        raise ExperimentError(f"unsupported lighting variant: {variant!r}")

    return wrapped


def make_render_still(
    original: Callable[[Any, Any], Any],
    ctx: "ExperimentContext",
) -> Callable[[Any, Any], Any]:
    def wrapped(scene: Any, path: Any) -> Any:
        if ctx.job is None:
            raise ExperimentError("render_still before add_studio/job bind")
        receipt = capture_pass_scene(
            scene,
            path=path,
            job=ctx.job,
            lights=ctx.list_lights(),
            variant=ctx.variant,
            declaration_sha256=ctx.declaration_sha256,
            snapshot_sha256=ctx.snapshot_sha256,
            source_identity=ctx.source_identity,
        )
        try:
            result = original(scene, path)
            output = Path(path)
            if output.is_file():
                receipt["output_sha256"] = sha256_file(output)
                receipt["pass_complete"] = True
            else:
                receipt["pass_complete"] = False
                receipt["output_sha256"] = None
            return result
        except Exception as error:
            receipt["pass_complete"] = False
            receipt["error_type"] = type(error).__name__
            raise
        finally:
            ctx.passes.append(receipt)

    return wrapped


class ExperimentContext:
    def __init__(
        self,
        *,
        variant: str,
        declaration_sha256: str,
        snapshot_sha256: str,
        source_identity: Mapping[str, Any],
        list_lights: Callable[[], Sequence[Any]],
        look_at: Callable[[Any, Sequence[float]], None],
        job: Mapping[str, Any] | None = None,
    ) -> None:
        self.variant = validate_variant(variant)
        self.declaration_sha256 = declaration_sha256
        self.snapshot_sha256 = snapshot_sha256
        self.source_identity = dict(source_identity)
        self.list_lights = list_lights
        self.look_at = look_at
        self.job: Mapping[str, Any] | None = job
        self.add_studio_calls = 0
        self.passes: list[dict[str, Any]] = []
        self.lights_after_original: list[dict[str, Any]] = []
        self.lights_after_candidate: list[dict[str, Any]] = []


def load_product_renderer() -> Any:
    spec = importlib.util.spec_from_file_location("packaging_render_job_rfe02", RENDER_JOB_PATH)
    if spec is None or spec.loader is None:
        raise ExperimentError(f"unable to load product renderer: {RENDER_JOB_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def blender_list_lights(bpy_module: Any) -> list[Any]:
    objects = getattr(getattr(bpy_module, "data", None), "objects", [])
    return [obj for obj in objects if str(getattr(obj, "type", "")) == "LIGHT"]


def run_experimental_main() -> None:
    envelope_raw = (os.environ.get(ENV_JOB) or "").strip()
    if not envelope_raw:
        raise SystemExit("BEIAN_RFE02_JOB missing")
    envelope = load_envelope(Path(envelope_raw))
    declaration = Path(str(envelope["declaration_path"]))
    declaration_sha = sha256_file(declaration)
    if declaration_sha != envelope.get("declaration_sha256"):
        raise SystemExit("declaration hash mismatch")
    renderer = load_product_renderer()
    job_path = renderer.job_path_from_argv()
    snapshot_sha = sha256_file(job_path)
    identity = source_identity_payload()
    try:
        import bpy  # type: ignore
    except ImportError as error:
        raise SystemExit("bpy unavailable in experimental wrapper") from error

    ctx = ExperimentContext(
        variant=envelope["variant"],
        declaration_sha256=declaration_sha,
        snapshot_sha256=snapshot_sha,
        source_identity=identity,
        list_lights=lambda: blender_list_lights(bpy),
        look_at=renderer.look_at,
    )
    original_add = renderer.add_studio
    original_still = renderer.render_still
    renderer.add_studio = make_add_studio(original_add, ctx)
    renderer.render_still = make_render_still(original_still, ctx)
    main_finished = False
    project_dir = None
    try:
        renderer.main()
        main_finished = True
    finally:
        renderer.add_studio = original_add
        renderer.render_still = original_still
        job = ctx.job or json.loads(Path(job_path).read_text(encoding="utf-8"))
        project_dir = Path(str(job.get("project_dir") or Path(job_path).parent))
        blender_result = None
        result_path = project_dir / "blender_result.json"
        if result_path.is_file():
            try:
                blender_result = json.loads(result_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                blender_result = None
        receipt = finalize_job_receipt(
            main_finished=main_finished,
            variant=ctx.variant,
            declaration_sha256=declaration_sha,
            snapshot_sha256=snapshot_sha,
            source_identity=identity,
            passes=ctx.passes,
            blender_result=blender_result if isinstance(blender_result, dict) else None,
            expected_nonce=job.get("execution_nonce"),
            outputs=job.get("outputs") if isinstance(job.get("outputs"), dict) else None,
        )
        receipt["add_studio_calls"] = ctx.add_studio_calls
        receipt["lights_after_original"] = ctx.lights_after_original
        receipt["lights_after_candidate"] = ctx.lights_after_candidate
        _write_json(project_dir / JOB_RECEIPT_NAME, receipt)
        _write_json(project_dir / PASS_RECEIPT_NAME, {"schema": "beian-rfe02-pass-receipts/1", "passes": ctx.passes})
    if not receipt["complete"]:
        raise SystemExit("rfe02 evidence incomplete")


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class _DictLightData:
    def __init__(self, payload: Mapping[str, Any]) -> None:
        self.type = payload.get("type")
        self.shape = payload.get("shape")
        self.size = payload.get("size")
        self.size_y = payload.get("size_y")
        self.energy = payload.get("energy")
        self.color = payload.get("color")


class _DictLight:
    def __init__(self, payload: Mapping[str, Any]) -> None:
        self.name = payload.get("name")
        self.location = tuple(payload.get("location") or ())
        self.rotation_euler = payload.get("rotation_euler")
        self.data = _DictLightData(payload)


def _as_vec3(value: Any, *, label: str) -> tuple[float, float, float]:
    try:
        return (float(value[0]), float(value[1]), float(value[2]))
    except Exception as error:
        raise ExperimentError(f"{label} is not a 3-vector") from error


def _read_vec3(value: Any, method: str) -> Any:
    try:
        return measured([float(value[0]), float(value[1]), float(value[2])], None, method)
    except Exception:
        return unavailable(f"{method}_unreadable", method=method)


def _read_float(value: Any, method: str) -> Any:
    try:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise TypeError
        return measured(float(value), None, method)
    except Exception:
        return unavailable(f"{method}_unreadable", method=method)


def _read_int(value: Any, method: str) -> Any:
    try:
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError
        return measured(int(value), None, method)
    except Exception:
        return unavailable(f"{method}_unreadable", method=method)


def _read_bool(value: Any, method: str) -> Any:
    if isinstance(value, bool):
        return measured(value, None, method)
    return unavailable(f"{method}_unreadable", method=method)


def _read_scalar(value: Any, method: str) -> Any:
    if value is None:
        return unavailable(f"{method}_missing", method=method)
    return measured(value if isinstance(value, (str, int, float, bool)) else str(value), None, method)


def _read_color(value: Any, method: str) -> Any:
    try:
        items = list(value)
        return measured([float(item) for item in items], None, method)
    except Exception:
        return unavailable(f"{method}_unreadable", method=method)


def _read_matrix(value: Any, method: str) -> Any:
    try:
        matrix = [[float(value[row][col]) for col in range(4)] for row in range(4)]
        return measured(matrix, None, method)
    except Exception:
        return unavailable(f"{method}_unreadable", method=method)


def _as_float_list(value: Any, count: int, label: str) -> list[float]:
    items = [float(value[index]) for index in range(count)]
    if len(items) != count:
        raise ExperimentError(label)
    return items


def _payload_unavailable(payload: Any) -> bool:
    return isinstance(payload, Mapping) and payload.get("status") == "unavailable"


def _vec_close(left: Any, right: Any, *, tol: float = 1e-6) -> bool:
    try:
        return all(abs(float(a) - float(b)) <= tol for a, b in zip(left, right, strict=True))
    except Exception:
        return False


def _num_close(left: Any, right: Any, *, tol: float = 1e-6) -> bool:
    try:
        return abs(float(left) - float(right)) <= tol
    except Exception:
        return False


def _scene_objects(scene: Any) -> list[Any]:
    collection = getattr(scene, "objects", None)
    if collection is None:
        data = getattr(scene, "data", None)
        collection = getattr(data, "objects", None) if data is not None else None
    if collection is None:
        return []
    return list(collection)


def _find_named(objects: Sequence[Any], suffix: str) -> Any | None:
    for obj in objects:
        name = str(getattr(obj, "name", "") or "")
        if name.endswith(suffix):
            return obj
    return None


def _mesh_vertex_count(obj: Any) -> Any:
    data = getattr(obj, "data", None)
    vertices = getattr(data, "vertices", None) if data is not None else None
    try:
        return measured(len(vertices), "1", "core.data.vertices")
    except Exception:
        return unavailable("vertex_count_unreadable", method="core.data.vertices")


def _object_materials(obj: Any) -> list[Any]:
    data = getattr(obj, "data", None)
    materials = getattr(data, "materials", None) if data is not None else None
    if materials is None:
        return []
    return [item for item in list(materials) if item is not None]


def _capture_material(material: Any) -> dict[str, Any]:
    name = getattr(material, "name", None)
    roughness = unavailable("material_roughness_unreadable", method="principled roughness")
    base_color = unavailable("material_base_color_unreadable", method="principled base color")
    try:
        nodes = material.node_tree.nodes
        shader = None
        for node in nodes:
            if str(getattr(node, "type", "")).endswith("BSDF_PRINCIPLED") or str(getattr(node, "type", "")) == "BSDF_PRINCIPLED":
                shader = node
                break
        if shader is not None:
            if "Roughness" in shader.inputs:
                roughness = _read_float(shader.inputs["Roughness"].default_value, "principled.Roughness")
            if "Base Color" in shader.inputs:
                base_color = _read_color(shader.inputs["Base Color"].default_value, "principled.Base Color")
    except Exception as error:
        roughness = unavailable(f"material_nodes_unreadable:{type(error).__name__}", method="material.node_tree")
    return {"name": name, "roughness": roughness, "base_color": base_color}


def _texture_identities(material: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    try:
        nodes = material.node_tree.nodes
    except Exception:
        return found
    for node in nodes:
        image = getattr(node, "image", None)
        if image is None:
            continue
        filepath = getattr(image, "filepath", None) or getattr(image, "filepath_raw", None)
        identity: dict[str, Any] = {"node": getattr(node, "name", None), "filepath": filepath}
        if filepath:
            path = Path(str(filepath))
            if path.is_file():
                identity["sha256"] = sha256_file(path)
            else:
                identity["sha256"] = None
                identity["reason"] = "texture_file_missing"
        else:
            identity["sha256"] = None
            identity["reason"] = "packed_or_missing_filepath"
        found.append(identity)
    return found


if __name__ == "__main__":
    run_experimental_main()
