#!/usr/bin/env python3
"""RF-07 colour-transform experiment wrapper.

Loaded as pipeline.BLENDER_SCRIPT only while the RF-07 driver runs.
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
RFE02_WRAPPER_PATH = Path(__file__).resolve().parent / "render_quality_experiment_blender.py"
ENV_JOB = "BEIAN_RF07_JOB"
COLOR_CANDIDATES = ("Standard", "Khronos PBR Neutral", "AgX")
REQUIRED_STILL_KEYS = ("front_right", "back_left")
NOT_ASSESSED = "not_assessed"
JOB_RECEIPT_NAME = "rf07-job-receipt.json"
ENVELOPE_SCHEMA = "beian-rf07-job-envelope/1"
JOB_SCHEMA = "beian-rf07-job-receipt/1"


class ExperimentError(RuntimeError):
    pass


def _rfe02() -> Any:
    spec = importlib.util.spec_from_file_location("packaging_rfe02_wrap_rf07", RFE02_WRAPPER_PATH)
    if spec is None or spec.loader is None:
        raise ExperimentError(f"unable to load RF-E02 wrapper: {RFE02_WRAPPER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical_dumps(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _look_is_none(value: Any) -> bool:
    return value in {None, "None", "NONE"}


def apply_view_transform(scene: Any, requested: str, *, look: str, exposure: float) -> str:
    if requested not in COLOR_CANDIDATES:
        raise ExperimentError(f"unsupported colour candidate: {requested!r}")
    view = getattr(scene, "view_settings", None)
    if view is None:
        raise ExperimentError("color_transform_unsupported: view_settings missing")
    before_look = getattr(view, "look", None)
    before_exposure = getattr(view, "exposure", None)
    try:
        view.view_transform = requested
    except Exception as error:
        raise ExperimentError(f"color_transform_unsupported: requested={requested}") from error
    actual = str(getattr(view, "view_transform", ""))
    if actual != requested:
        raise ExperimentError(f"color_transform_unsupported: requested={requested} actual={actual}")
    if look != "None":
        raise ExperimentError("look_must_stay_none")
    view.look = look
    view.exposure = float(exposure)
    actual_look = getattr(view, "look", None)
    if not _look_is_none(actual_look):
        raise ExperimentError(f"look_changed: {actual_look!r}")
    actual_exposure = float(getattr(view, "exposure"))
    if actual_exposure != float(exposure):
        raise ExperimentError(f"exposure_changed: {actual_exposure}")
    if not _look_is_none(before_look) and str(before_look) not in {str(look), "None"}:
        raise ExperimentError("look_changed_before_assignment")
    if before_exposure is not None and float(before_exposure) not in {float(exposure), 0.0}:
        # Product add_studio may have already set the contracted exposure.
        if float(before_exposure) != float(exposure):
            raise ExperimentError("exposure_changed_before_assignment")
    return actual


def _finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _vec_values(value: Any) -> list[float]:
    if value is None:
        raise TypeError("missing vector")
    if hasattr(value, "x") and hasattr(value, "y"):
        values = [float(value.x), float(value.y)]
        if hasattr(value, "z"):
            values.append(float(value.z))
        return values
    return [float(item) for item in value]


def _content_sha256(payload: Any) -> str:
    return hashlib.sha256(canonical_dumps(payload).encode("utf-8")).hexdigest()


def _image_identity(image: Any) -> dict[str, Any] | None:
    if image is None:
        return None
    colorspace = getattr(getattr(image, "colorspace_settings", None), "name", None)
    packed = getattr(image, "packed_file", None)
    digest = None
    source = None
    is_packed = False
    data = getattr(packed, "data", None) if packed is not None else None
    if data:
        raw = bytes(data) if not isinstance(data, (bytes, bytearray)) else bytes(data)
        digest = hashlib.sha256(raw).hexdigest()
        source = "packed_file"
        is_packed = True
    else:
        filepath = getattr(image, "filepath", None) or getattr(image, "filepath_raw", None)
        path = Path(str(filepath)) if filepath else None
        if path is not None and path.is_file():
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            source = "filepath"
        else:
            try:
                pixels = [round(float(item), 6) for item in list(getattr(image, "pixels", []) or [])]
                size = [int(item) for item in list(getattr(image, "size", []) or [])]
                digest = _content_sha256({"size": size, "pixels": pixels})
                source = "pixels"
            except Exception:
                digest = None
    if not digest or not colorspace:
        return None
    return {"sha256": digest, "color_space": str(colorspace), "packed": is_packed, "source": source}


def _mesh_snapshot(obj: Any) -> dict[str, Any]:
    wrap = _rfe02()
    data = getattr(obj, "data", None)
    name = getattr(obj, "name", None)
    try:
        vertices = [_vec_values(getattr(item, "co", item)) for item in list(getattr(data, "vertices", []) or [])]
        polygons = [list(getattr(poly, "vertices", [])) for poly in list(getattr(data, "polygons", []) or [])]
        uv_payload = []
        for layer in list(getattr(data, "uv_layers", []) or []):
            uv_payload.append(
                {
                    "name": getattr(layer, "name", None),
                    "data": [_vec_values(getattr(loop, "uv", loop))[:2] for loop in list(getattr(layer, "data", []) or [])],
                }
            )
        geometry = {
            "vertices": vertices, "polygons": polygons,
            "material_indices": [getattr(poly, "material_index", 0) for poly in list(getattr(data, "polygons", []) or [])],
        }
        if uv_payload:
            uv = wrap.measured(_content_sha256(uv_payload), None, "mesh.uv_layers")
        else:
            reason = "core_has_no_uv" if name and "core" in str(name).lower() else "mesh_has_no_uv"
            uv = wrap.unavailable(reason, method="mesh.uv_layers")
        return {
            "name": name,
            "transform": _json_safe(getattr(obj, "matrix_world", None)),
            "material_bindings": [getattr(mat, "name", None) for mat in list(getattr(data, "materials", []) or [])],
            "geometry_sha256": wrap.measured(_content_sha256(geometry), None, "mesh vertices/polygons"),
            "uv_sha256": uv,
            "vertex_count": wrap.measured(len(vertices), "1", "mesh.vertices"),
        }
    except Exception as error:
        return {
            "name": name,
            "geometry_sha256": wrap.unavailable(f"mesh_unreadable:{type(error).__name__}", method="mesh"),
            "uv_sha256": wrap.unavailable("uv_unreadable", method="mesh.uv_layers"),
            "vertex_count": wrap.unavailable("vertex_count_unreadable", method="mesh.vertices"),
        }


def _json_safe(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return str(type(value).__name__)
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return float(value) if math.isfinite(value) else None
    if hasattr(value, "x") and hasattr(value, "y"):
        try:
            if hasattr(value, "w"):
                return [float(value.x), float(value.y), float(value.z), float(value.w)]
            return _vec_values(value)
        except Exception:
            pass
    try:
        return [_json_safe(item, depth + 1) for item in list(value)]
    except TypeError:
        if _finite_number(value):
            return float(value)
        return str(value)


def _interesting_inputs(node: Any) -> dict[str, Any]:
    found: dict[str, Any] = {}
    inputs = getattr(node, "inputs", None)
    items: list[tuple[Any, Any]] = []
    if isinstance(inputs, Mapping):
        items = list(inputs.items())
    elif inputs is not None:
        for sock in list(inputs):
            items.append((getattr(sock, "name", None) or getattr(sock, "identifier", None), sock))
    for index, (name, sock) in enumerate(items):
        value = sock
        linked = False
        if not isinstance(sock, (int, float, str, list, tuple, bool)) and hasattr(sock, "default_value"):
            linked = bool(getattr(sock, "is_linked", False))
            value = getattr(sock, "default_value")
        elif not isinstance(sock, (int, float, str, list, tuple, bool)):
            continue  # Shader sockets have no independent default value.
        key = str(name) if str(name) not in found else f"{index}:{name}"
        found[key] = _json_safe(value)
        found[f"{key}_linked"] = linked
    return found


def _material_graph(material: Any) -> dict[str, Any]:
    tree = getattr(material, "node_tree", None)
    nodes_out = []
    links_out = []
    node_list = list(getattr(tree, "nodes", []) or []) if tree is not None else []
    for node in node_list:
        row = {
            "name": getattr(node, "name", None),
            "type": getattr(node, "bl_idname", None) or getattr(node, "type", None),
            "inputs": _interesting_inputs(node),
        }
        for key in ("operation", "blend_type", "data_type", "interpolation", "extension", "space", "uv_map"):
            if hasattr(node, key):
                row[key] = _json_safe(getattr(node, key))
        image = _image_identity(getattr(node, "image", None))
        if image is not None:
            row["image"] = image
        nodes_out.append(row)
    for link in list(getattr(tree, "links", []) or []) if tree is not None else []:
        links_out.append(
            [
                getattr(getattr(link, "from_node", None), "name", None),
                getattr(getattr(link, "from_socket", None), "identifier", None),
                getattr(getattr(link, "to_node", None), "name", None),
                getattr(getattr(link, "to_socket", None), "identifier", None),
            ]
        )
    links_out.sort()
    return {"name": getattr(material, "name", None), "nodes": nodes_out, "links": links_out}


def capture_seed(scene: Any) -> dict[str, Any]:
    wrap = _rfe02()
    engine = str(getattr(getattr(scene, "render", None), "engine", "") or "")
    cycles = getattr(scene, "cycles", None)
    extra = None
    if cycles is not None and hasattr(cycles, "seed"):
        try:
            extra = wrap.measured(int(cycles.seed), "1", "scene.cycles.seed")
        except Exception:
            extra = wrap.unavailable("cycles_seed_unreadable", method="scene.cycles.seed")
    if "EEVEE" in engine.upper():
        eevee = getattr(scene, "eevee", None)
        if eevee is not None:
            for name in ("sampling_seed", "seed", "hash_offset"):
                if hasattr(eevee, name):
                    raw = getattr(eevee, name)
                    if _finite_number(raw):
                        payload = wrap.measured(raw, "1", f"scene.eevee.{name}")
                        if extra is not None:
                            payload = {**payload, "cycles_seed": extra}
                        return payload
        payload = wrap.unavailable("eevee_has_no_sampling_seed", method="scene.eevee seed/hash_offset")
        if extra is not None:
            payload = {**payload, "cycles_seed": extra}
        return payload
    if extra is not None:
        return extra
    return wrap.unavailable("sampling_seed_unsupported", method="scene render engine seed")


def capture_fixed_scene(scene: Any) -> dict[str, Any]:
    wrap = _rfe02()
    objects = list(getattr(scene, "objects", []) or [])
    meshes = []
    materials = []
    seen_mat = set()
    for obj in objects:
        if str(getattr(obj, "type", "")) != "MESH":
            continue
        meshes.append(_mesh_snapshot(obj))
        data = getattr(obj, "data", None)
        for material in list(getattr(data, "materials", []) or []) if data is not None else []:
            if material is None:
                continue
            key = id(material)
            if key in seen_mat:
                continue
            seen_mat.add(key)
            materials.append(_material_graph(material))
    frame_current = wrap.unavailable("frame_current_unreadable", method="scene.frame_current")
    frame_sub = wrap.unavailable("frame_subframe_unreadable", method="scene.frame_subframe")
    try:
        frame_current = wrap.measured(int(getattr(scene, "frame_current")), "1", "scene.frame_current")
    except Exception:
        pass
    try:
        frame_sub = wrap.measured(float(getattr(scene, "frame_subframe")), "1", "scene.frame_subframe")
    except Exception:
        pass
    return {
        "meshes": meshes,
        "materials": materials,
        "seed": capture_seed(scene),
        "frame": {"current": frame_current, "subframe": frame_sub},
    }


def rf07_pass_evidence_incomplete(receipt: Mapping[str, Any]) -> bool:
    wrap = _rfe02()
    if not isinstance(receipt, Mapping):
        return True
    adapted = dict(receipt)
    adapted["variant"] = wrap.VARIANT_CONTROL
    if wrap.pass_evidence_incomplete(adapted):
        return True
    candidate = receipt.get("candidate") or receipt.get("variant")
    if candidate not in COLOR_CANDIDATES:
        return True
    if receipt.get("output_key") not in REQUIRED_STILL_KEYS:
        return True
    fixed = receipt.get("fixed_scene")
    if not isinstance(fixed, Mapping):
        return True
    meshes = fixed.get("meshes")
    if not isinstance(meshes, list) or not meshes:
        return True
    have_uv = False
    for mesh in meshes:
        if not isinstance(mesh, Mapping):
            return True
        geom = mesh.get("geometry_sha256")
        if not wrap._metric_valid(geom) or not wrap.valid_sha256(geom.get("value")):
            return True
        uv = mesh.get("uv_sha256")
        if wrap._metric_valid(uv) and wrap.valid_sha256(uv.get("value")):
            have_uv = True
        elif (
            isinstance(uv, Mapping)
            and uv.get("status") == "unavailable"
            and uv.get("reason")
            and uv.get("method")
        ):
            pass
        else:
            return True
        if not wrap._positive_metric(mesh.get("vertex_count")):
            return True
    if not have_uv:
        return True
    materials = fixed.get("materials")
    if not isinstance(materials, list) or not materials:
        return True
    saw_image = False
    saw_coat = False
    for mat in materials:
        if not isinstance(mat, Mapping):
            return True
        nodes = mat.get("nodes")
        if not isinstance(nodes, list) or not nodes:
            return True
        if not isinstance(mat.get("links"), list):
            return True
        for node in nodes:
            if not isinstance(node, Mapping) or not node.get("type") or not node.get("name"):
                return True
            inputs = node.get("inputs") if isinstance(node.get("inputs"), Mapping) else {}
            if "Coat Weight" in inputs:
                if not _finite_number(inputs["Coat Weight"]):
                    return True
                saw_coat = True
            if "Strength" in inputs and not _finite_number(inputs["Strength"]):
                return True
            image = node.get("image")
            if image is not None:
                if (
                    not isinstance(image, Mapping)
                    or not wrap.valid_sha256(image.get("sha256"))
                    or not image.get("color_space")
                ):
                    return True
                saw_image = True
    if not saw_image or not saw_coat:
        return True
    seed = fixed.get("seed")
    if not isinstance(seed, Mapping):
        return True
    if seed.get("status") == "measured":
        if not wrap._metric_valid(seed):
            return True
    elif seed.get("status") == "unavailable":
        if not seed.get("reason") or not seed.get("method"):
            return True
        reason = str(seed.get("reason") or "")
        if "eevee" not in reason and "unsupported" not in reason:
            return True
    else:
        return True
    frame = fixed.get("frame")
    if not isinstance(frame, Mapping):
        return True
    if not wrap._metric_valid(frame.get("current")) or not wrap._metric_valid(frame.get("subframe")):
        return True
    return False


def validate_candidate(value: Any) -> str:
    if value not in COLOR_CANDIDATES:
        raise ExperimentError(f"unsupported colour candidate: {value!r}")
    return str(value)


def load_envelope(path: Path) -> dict[str, Any]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("schema") != ENVELOPE_SCHEMA:
        raise ExperimentError("invalid RF-07 job envelope")
    validate_candidate(payload.get("candidate"))
    return payload


def load_product_renderer() -> Any:
    spec = importlib.util.spec_from_file_location("packaging_render_job_rf07", RENDER_JOB_PATH)
    if spec is None or spec.loader is None:
        raise ExperimentError(f"unable to load product renderer: {RENDER_JOB_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_add_studio(
    original: Callable[[Mapping[str, Any]], Any],
    ctx: "ExperimentContext",
) -> Callable[[Mapping[str, Any]], Any]:
    wrap = _rfe02()

    def wrapped(job: Mapping[str, Any]) -> Any:
        ctx.add_studio_calls += 1
        ctx.job = job
        camera = original(job)
        apply_view_transform(
            ctx.scene(),
            ctx.candidate,
            look=ctx.look,
            exposure=ctx.exposure,
        )
        ctx.lights_after = [wrap.snapshot_light_state(light) for light in ctx.list_lights()]
        return camera

    return wrapped


def make_render_still(
    original: Callable[[Any, Any], Any],
    ctx: "ExperimentContext",
) -> Callable[[Any, Any], Any]:
    wrap = _rfe02()

    def wrapped(scene: Any, path: Any) -> Any:
        if ctx.job is None:
            raise ExperimentError("render_still before add_studio/job bind")
        receipt = wrap.capture_pass_scene(
            scene,
            path=path,
            job=ctx.job,
            lights=ctx.list_lights(),
            variant="control",
            declaration_sha256=ctx.declaration_sha256,
            snapshot_sha256=ctx.snapshot_sha256,
            source_identity=ctx.source_identity,
        )
        receipt["fixed_scene"] = capture_fixed_scene(scene)
        receipt["variant"] = ctx.candidate
        receipt["candidate"] = ctx.candidate
        try:
            result = original(scene, path)
            output = Path(path)
            if output.is_file():
                receipt["output_sha256"] = wrap.sha256_file(output)
                receipt["pass_complete"] = not rf07_pass_evidence_incomplete(receipt)
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
        candidate: str,
        look: str,
        exposure: float,
        declaration_sha256: str,
        snapshot_sha256: str,
        source_identity: Mapping[str, Any],
        list_lights: Callable[[], Sequence[Any]],
        scene: Callable[[], Any],
        job: Mapping[str, Any] | None = None,
    ) -> None:
        self.candidate = validate_candidate(candidate)
        self.look = look
        self.exposure = float(exposure)
        self.declaration_sha256 = declaration_sha256
        self.snapshot_sha256 = snapshot_sha256
        self.source_identity = dict(source_identity)
        self.list_lights = list_lights
        self.scene = scene
        self.job: Mapping[str, Any] | None = job
        self.add_studio_calls = 0
        self.passes: list[dict[str, Any]] = []
        self.lights_after: list[dict[str, Any]] = []


def source_identity_payload() -> dict[str, str]:
    wrap = _rfe02()
    identity = wrap.source_identity_payload()
    identity["wrapper_sha256"] = wrap.sha256_file(Path(__file__).resolve())
    return identity


def run_experimental_main() -> None:
    wrap = _rfe02()
    envelope_raw = (os.environ.get(ENV_JOB) or "").strip()
    if not envelope_raw:
        raise SystemExit("BEIAN_RF07_JOB missing")
    envelope = load_envelope(Path(envelope_raw))
    declaration = Path(str(envelope["declaration_path"]))
    declaration_sha = wrap.sha256_file(declaration)
    if declaration_sha != envelope.get("declaration_sha256"):
        raise SystemExit("declaration hash mismatch")
    renderer = load_product_renderer()
    job_path = renderer.job_path_from_argv()
    snapshot_sha = wrap.sha256_file(job_path)
    identity = source_identity_payload()
    try:
        import bpy  # type: ignore
    except ImportError as error:
        raise SystemExit("bpy unavailable in experimental wrapper") from error

    ctx = ExperimentContext(
        candidate=envelope["candidate"],
        look=str(envelope.get("look") or "None"),
        exposure=float(envelope.get("exposure") or 0.0),
        declaration_sha256=declaration_sha,
        snapshot_sha256=snapshot_sha,
        source_identity=identity,
        list_lights=lambda: wrap.blender_list_lights(bpy),
        scene=lambda: bpy.context.scene,
    )
    renderer.add_studio = make_add_studio(renderer.add_studio, ctx)
    renderer.render_still = make_render_still(renderer.render_still, ctx)
    main_error = None
    try:
        renderer.main()
        main_finished = True
    except Exception as error:
        main_finished = False
        main_error = error
        print(f"rf07 wrapper main failed: {error}", file=sys.stderr)
    job = ctx.job or json.loads(job_path.read_text(encoding="utf-8"))
    still_passes = [
        item for item in ctx.passes if item.get("output_key") in REQUIRED_STILL_KEYS
    ]
    receipt = {
        "schema": JOB_SCHEMA,
        "candidate": ctx.candidate,
        "complete": False,
        "declaration_sha256": declaration_sha,
        "snapshot_sha256": snapshot_sha,
        "source_identity": identity,
        "passes": still_passes,
        "lights": ctx.lights_after,
        "quality_improvement": NOT_ASSESSED,
        "human_review": NOT_ASSESSED,
    }
    outputs = job.get("outputs") if isinstance(job, Mapping) else {}
    closed = True
    for key in REQUIRED_STILL_KEYS:
        raw = (outputs or {}).get(key)
        path = Path(str(raw)) if raw else None
        if path is None or not path.is_file():
            closed = False
            continue
        matching = next((item for item in still_passes if item.get("output_key") == key), None)
        if matching is None or matching.get("pass_complete") is not True:
            closed = False
    receipt["complete"] = bool(main_finished and closed and still_passes)
    dest = Path(job["project_dir"]) / JOB_RECEIPT_NAME if isinstance(job, Mapping) and job.get("project_dir") else job_path.parent / JOB_RECEIPT_NAME
    dest.write_text(canonical_dumps(receipt) + "\n", encoding="utf-8")
    if main_error is not None:
        raise main_error
    if not receipt["complete"]:
        raise SystemExit("rf07 evidence incomplete")


if __name__ == "__main__":
    run_experimental_main()
