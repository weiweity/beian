import json
import math
import sys
import time
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

_PACKAGING = Path(__file__).resolve().parents[1]
if str(_PACKAGING) not in sys.path:
    sys.path.insert(0, str(_PACKAGING))
from camera_frame import aabb_after_z_rotation, camera_fit_after_yaw, camera_location_mm, camera_ortho_scale_mm, camera_target_mm
from glb_verify import (
    SEMANTIC_FACES,
    compare_glb_dimensions,
    compare_glb_material_contract,
    compare_glb_texture_bindings,
    load_glb_json,
)


def job_path_from_argv():
    if "--" not in sys.argv:
        raise SystemExit("missing job json after --")
    args = sys.argv[sys.argv.index("--") + 1 :]
    if len(args) != 1:
        raise SystemExit("usage: blender --background --python render_job.py -- job.json")
    return Path(args[0]).resolve()


def clean_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for item in list(collection):
            if item.users == 0:
                collection.remove(item)


def make_material(name, image_path, roughness=0.52, specular_ior=0.08):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    texture = nodes.new("ShaderNodeTexImage")
    image = bpy.data.images.load(str(image_path), check_existing=False)
    image.pack()
    texture.image = image
    texture.interpolation = "Linear"
    alpha_mask = nodes.new("ShaderNodeMath")
    alpha_mask.operation = "ROUND"
    alpha_mask.use_clamp = True
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Specular IOR Level"].default_value = specular_ior
    links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    links.new(texture.outputs["Alpha"], alpha_mask.inputs[0])
    links.new(alpha_mask.outputs[0], shader.inputs["Alpha"])
    # Alpha is a binary physical-coverage mask, not translucent paper.  The
    # opaque core immediately behind the panel supplies the substrate colour.
    if hasattr(material, "blend_method"):
        material.blend_method = "CLIP"
        material.alpha_threshold = 0.5
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    return material


def make_panel(name, size_x, size_y, location, rotation, material, bevel=0.65):
    bpy.ops.mesh.primitive_plane_add(size=2, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = (size_x / 2.0, size_y / 2.0, 1.0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)
    bevel_modifier = obj.modifiers.new("Micro bevel", "BEVEL")
    bevel_modifier.width = bevel
    bevel_modifier.segments = 3
    return obj


def add_panel(name, vertices, material):
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], [(0, 1, 2, 3)])
    mesh.materials.append(material)
    mesh.update()
    uv = mesh.uv_layers.new(name="Artwork UV")
    coords = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    for loop, coord in zip(mesh.loops, coords):
        uv.data[loop.index].uv = coord
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def make_core_material(substrate_rgba):
    material = bpy.data.materials.new("MAT_PaperboardEdge")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Base Color"].default_value = tuple(float(value) for value in substrate_rgba)
    shader.inputs["Roughness"].default_value = 0.60
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    return material


def add_box(job):
    dims = job["dimensions_mm"]
    width = float(dims["width"])
    depth = float(dims["depth"])
    height = float(dims["height"])
    assets = {name: Path(path) for name, path in job["assets"].items()}
    roughness = float(job["render"].get("material_roughness", 0.52))
    specular_ior = float(job["render"].get("material_specular_ior", 0.08))
    substrate_rgba = job["render"].get("substrate_rgba", [1.0, 1.0, 1.0, 1.0])
    if (
        not isinstance(substrate_rgba, list)
        or len(substrate_rgba) != 4
        or any(not isinstance(value, (int, float)) or not 0.0 <= float(value) <= 1.0 for value in substrate_rgba)
        or float(substrate_rgba[3]) != 1.0
    ):
        raise RuntimeError("render.substrate_rgba must be an opaque four-channel colour in the 0-1 range")
    mats = {
        name: make_material(f"MAT_{name}", path, roughness, specular_ior)
        for name, path in assets.items()
    }
    root = bpy.data.objects.new(f"{job['code']}_Model_Root", None)
    bpy.context.collection.objects.link(root)
    root["source_ai"] = job["source_ai"]
    root["dimensions_mm"] = f"{width} x {depth} x {height}"

    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, height / 2.0))
    core = bpy.context.object
    core.name = f"{job['code']}_Box_Core"
    core.dimensions = (width, depth, height)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    core.data.materials.append(make_core_material(substrate_rgba))
    bevel = core.modifiers.new("Paperboard edge radius", "BEVEL")
    bevel.width = 0.45
    bevel.segments = 4
    bevel.limit_method = "ANGLE"

    gap = 0.065
    x0, x1 = -width / 2.0, width / 2.0
    y0, y1 = -depth / 2.0, depth / 2.0
    z0, z1 = 0.0, height
    panels = [
        add_panel("Front", [(x0, y0-gap, z0), (x1, y0-gap, z0), (x1, y0-gap, z1), (x0, y0-gap, z1)], mats["front"]),
        add_panel("Right", [(x1+gap, y0, z0), (x1+gap, y1, z0), (x1+gap, y1, z1), (x1+gap, y0, z1)], mats["right"]),
        add_panel("Back", [(x1, y1+gap, z0), (x0, y1+gap, z0), (x0, y1+gap, z1), (x1, y1+gap, z1)], mats["back"]),
        add_panel("Left", [(x0-gap, y1, z0), (x0-gap, y0, z0), (x0-gap, y0, z1), (x0-gap, y1, z1)], mats["left"]),
        add_panel("Top", [(x0, y0, z1+gap), (x1, y0, z1+gap), (x1, y1, z1+gap), (x0, y1, z1+gap)], mats["top"]),
        add_panel("Bottom", [(x0, y1, z0-gap), (x1, y1, z0-gap), (x1, y0, z0-gap), (x0, y0, z0-gap)], mats["bottom"]),
    ]
    model_objects = [core, *panels]
    for obj in model_objects:
        obj.parent = root
    return root, model_objects


def look_at(obj, target=(0, 0, 0)):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def add_studio(job):
    scene = bpy.context.scene
    render_config = job["render"]
    exact_white_background = bool(render_config.get("exact_white_background", True))
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = int(render_config["resolution_x"])
    scene.render.resolution_y = int(render_config["resolution_y"])
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = exact_white_background
    scene.render.image_settings.compression = 35
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = str(render_config.get("view_transform", "Standard"))
    scene.view_settings.look = str(render_config.get("look", "None"))
    scene.view_settings.exposure = float(render_config.get("exposure", 0.0))
    scene.world.color = (1.0, 1.0, 1.0)

    world = scene.world or bpy.data.worlds.new("Packaging World")
    scene.world = world
    world.use_nodes = True
    world_nodes = world.node_tree.nodes
    world_links = world.node_tree.links
    for node in list(world_nodes):
        world_nodes.remove(node)
    world_output = world_nodes.new("ShaderNodeOutputWorld")
    background = world_nodes.new("ShaderNodeBackground")
    background.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    background.inputs["Strength"].default_value = float(render_config.get("world_strength", 0.62))
    world_links.new(background.outputs["Background"], world_output.inputs["Surface"])

    if not exact_white_background:
        bpy.ops.mesh.primitive_plane_add(size=600, location=(0, 0, -0.8))
        floor = bpy.context.object
        floor.name = "White floor"
        floor_mat = bpy.data.materials.new("MAT_WhiteFloor")
        floor_mat.diffuse_color = (0.95, 0.95, 0.95, 1)
        floor_mat.use_nodes = True
        floor_nodes = floor_mat.node_tree.nodes
        floor_links = floor_mat.node_tree.links
        for node in list(floor_nodes):
            floor_nodes.remove(node)
        floor_output = floor_nodes.new("ShaderNodeOutputMaterial")
        floor_shader = floor_nodes.new("ShaderNodeBsdfPrincipled")
        floor_shader.inputs["Base Color"].default_value = (0.96, 0.96, 0.96, 1)
        floor_shader.inputs["Roughness"].default_value = 0.82
        if floor_shader.inputs.get("Emission Color"):
            floor_shader.inputs["Emission Color"].default_value = (1.0, 1.0, 1.0, 1.0)
        if floor_shader.inputs.get("Emission Strength"):
            floor_shader.inputs["Emission Strength"].default_value = 3.0
        floor_links.new(floor_shader.outputs["BSDF"], floor_output.inputs["Surface"])
        floor.data.materials.append(floor_mat)

        bpy.ops.mesh.primitive_plane_add(size=520, location=(0, 130, 145), rotation=(math.radians(90), 0, 0))
        backdrop = bpy.context.object
        backdrop.name = "White backdrop"
        backdrop.data.materials.append(floor_mat)

    bpy.ops.object.light_add(type="AREA", location=(-135, -190, 275))
    key = bpy.context.object
    key.name = "Key softbox"
    light_scale = float(render_config.get("light_energy_scale", 4.0))
    key.data.energy = 105000 * light_scale
    key.data.shape = "RECTANGLE"
    key.data.size = 120
    key.data.size_y = 150
    look_at(key, (0, 0, 90))

    bpy.ops.object.light_add(type="AREA", location=(155, -120, 175))
    fill = bpy.context.object
    fill.name = "Fill softbox"
    fill.data.energy = 62000 * light_scale
    fill.data.size = 110
    look_at(fill, (0, 0, 90))

    bpy.ops.object.light_add(type="AREA", location=(0, 15, 315))
    rim = bpy.context.object
    rim.name = "Rim softbox"
    rim.data.energy = 72000 * light_scale
    rim.data.size = 95
    look_at(rim, (0, 0, 90))

    dims = job["dimensions_mm"]
    width = float(dims["width"])
    depth = float(dims["depth"])
    height = float(dims["height"])
    loc = camera_location_mm(width, depth, height)
    target = camera_target_mm(width, depth, height)
    bpy.ops.object.camera_add(location=loc)
    camera = bpy.context.object
    camera.name = "Product Camera"
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = float(job["render"].get("camera_ortho_scale_mm") or camera_ortho_scale_mm(width, depth, height))
    camera.data.clip_start = 0.1
    camera.data.clip_end = max(4000.0, camera.data.ortho_scale * 8)
    look_at(camera, target)
    scene.camera = camera
    return camera


def apply_camera_fit(camera, job, yaw_rad):
    dims = job["dimensions_mm"]
    width = float(dims["width"])
    depth = float(dims["depth"])
    height = float(dims["height"])
    loc, target, scale = camera_fit_after_yaw(width, depth, height, yaw_rad)
    pinned = float(job["render"].get("camera_ortho_scale_mm") or 0)
    span_w, span_d, _span_h = aabb_after_z_rotation(width, depth, height, yaw_rad)
    camera.location = loc
    if pinned and abs(span_w - width) < 1e-6 and abs(span_d - depth) < 1e-6:
        camera.data.ortho_scale = pinned
    else:
        camera.data.ortho_scale = scale
    camera.data.clip_end = max(4000.0, camera.data.ortho_scale * 8)
    look_at(camera, target)


def render_views(job, root):
    scene = bpy.context.scene
    camera = scene.camera
    outputs = job["outputs"]
    front_rotation = math.radians(float(job["render"].get("front_rotation_deg", 0)))
    back_rotation = math.radians(float(job["render"].get("back_rotation_deg", 180)))
    root.rotation_euler.z = front_rotation
    bpy.context.view_layer.update()
    apply_camera_fit(camera, job, front_rotation)
    scene.render.filepath = outputs["front_right"]
    bpy.ops.render.render(write_still=True)

    root.rotation_euler.z = back_rotation
    bpy.context.view_layer.update()
    apply_camera_fit(camera, job, back_rotation)
    scene.render.filepath = outputs["back_left"]
    bpy.ops.render.render(write_still=True)
    root.rotation_euler.z = 0.0


def export_model(job, root, model_objects):
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 0.001
    scene["product_code"] = job["code"]
    scene["display_name"] = job["display_name"]
    scene["source_ai"] = job["source_ai"]
    scene["dimensions_mm"] = json.dumps(job["dimensions_mm"], ensure_ascii=False)
    bpy.ops.wm.save_as_mainfile(filepath=job["outputs"]["blend"])

    bpy.ops.object.select_all(action="DESELECT")
    for obj in model_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = model_objects[0]
    scene.unit_settings.scale_length = 1.0
    scale_to_metres = Matrix.Scale(0.001, 4)
    for obj in model_objects:
        world_matrix = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = scale_to_metres @ world_matrix
    bpy.context.view_layer.update()
    gltf_kwargs = dict(
        filepath=job["outputs"]["glb"],
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
    )
    try:
        bpy.ops.export_scene.gltf(**gltf_kwargs)
    except TypeError:
        gltf_kwargs.pop("export_materials", None)
        bpy.ops.export_scene.gltf(**gltf_kwargs)


def verify_glb(job):
    substrate_rgba = job["render"].get("substrate_rgba", [1.0, 1.0, 1.0, 1.0])
    try:
        material_report = compare_glb_material_contract(
            load_glb_json(job["outputs"]["glb"]),
            job["assets"],
            substrate_rgba,
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError(f"GLB verification failed: cannot inspect exported material contract: {error}") from error
    if not material_report["ok"]:
        raise RuntimeError(
            "GLB verification failed: material contract mismatch="
            + json.dumps(material_report, ensure_ascii=False, sort_keys=True)
        )
    clean_scene()
    bpy.ops.import_scene.gltf(filepath=job["outputs"]["glb"])
    points = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    if not points:
        raise RuntimeError("GLB verification failed: no mesh objects")

    def material_base_color_images(material):
        if not material or not material.use_nodes:
            return []
        images = []
        for node in material.node_tree.nodes:
            if node.type != "BSDF_PRINCIPLED" or node.inputs.get("Base Color") is None:
                continue
            pending = [link.from_node for link in node.inputs["Base Color"].links]
            visited = set()
            while pending:
                upstream = pending.pop()
                marker = id(upstream)
                if marker in visited:
                    continue
                visited.add(marker)
                if upstream.type == "TEX_IMAGE" and getattr(upstream, "image", None):
                    images.append(upstream.image.name)
                pending.extend(
                    link.from_node
                    for input_socket in upstream.inputs
                    for link in input_socket.links
                )
        return images

    # A single texture anywhere in the file is not enough. Every semantic face
    # must keep the material and exact source image assigned by ResolvedPackagingJob.
    bindings = {}
    for face in SEMANTIC_FACES:
        face_objects = [
            obj
            for obj in bpy.context.scene.objects
            if obj.type == "MESH"
            and obj.name.lower().split(".", 1)[0].removesuffix("_mesh") == face
        ]
        bindings[face] = [
            {"material": material.name, "images": material_base_color_images(material)}
            for obj in face_objects
            for material in obj.data.materials
            if material
        ]
    binding_report = compare_glb_texture_bindings(bindings, job["assets"])
    if not binding_report["ok"]:
        raise RuntimeError(
            "GLB verification failed: semantic artwork binding mismatch="
            + json.dumps(binding_report, ensure_ascii=False, sort_keys=True)
        )
    mins = [min(point[i] for point in points) for i in range(3)]
    maxs = [max(point[i] for point in points) for i in range(3)]
    report = compare_glb_dimensions(
        [maxs[i] - mins[i] for i in range(3)],
        job["dimensions_mm"],
        float(job["glb_tolerance_mm"]),
    )
    if not report["ok"]:
        raise RuntimeError(
            "GLB axis dimension mismatch: "
            f"measured={report['measured_mm']}, expected={report['expected_mm']}, "
            f"tolerance={report['tolerance_mm']}"
        )
    return {**report, "material_contract": material_report}


def main():
    started = time.perf_counter()
    job_path = job_path_from_argv()
    job = json.loads(job_path.read_text(encoding="utf-8"))
    for path in job["outputs"].values():
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    clean_scene()
    root, model_objects = add_box(job)
    add_studio(job)
    render_views(job, root)
    export_model(job, root, model_objects)
    dimension_report = verify_glb(job)
    measured_sorted = sorted(dimension_report["measured_mm"].values())
    errors_sorted = sorted(dimension_report["error_mm"].values())
    result = {
        "code": job["code"],
        "outputs": job["outputs"],
        "glb_dimensions_mm": {
            key: round(value, 4) for key, value in dimension_report["measured_mm"].items()
        },
        "glb_dimension_error_mm": {
            key: round(value, 4) for key, value in dimension_report["error_mm"].items()
        },
        # Compatibility fields remain, but they no longer decide pass/fail.
        "glb_dimensions_mm_sorted": [round(value, 4) for value in measured_sorted],
        "glb_dimension_error_mm_sorted": [round(value, 4) for value in errors_sorted],
        "render_resolution": [job["render"]["resolution_x"], job["render"]["resolution_y"]],
        "blender_elapsed_s": round(time.perf_counter() - started, 3),
    }
    result_path = Path(job["project_dir"]) / "blender_result.json"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
