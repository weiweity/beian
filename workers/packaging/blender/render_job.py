import json
import math
import sys
import time
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


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


def make_material(name, image_path, roughness=0.43):
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
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Specular IOR Level"].default_value = 0.28
    links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    links.new(texture.outputs["Alpha"], shader.inputs["Alpha"])
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


def make_core_material():
    material = bpy.data.materials.new("MAT_PaperboardEdge")
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (0.80, 0.81, 0.81, 1.0)
    shader.inputs["Roughness"].default_value = 0.60
    return material


def add_box(job):
    dims = job["dimensions_mm"]
    width = float(dims["width"])
    depth = float(dims["depth"])
    height = float(dims["height"])
    assets = {name: Path(path) for name, path in job["assets"].items()}
    mats = {name: make_material(f"MAT_{name}", path) for name, path in assets.items()}
    root = bpy.data.objects.new(f"{job['code']}_Model_Root", None)
    bpy.context.collection.objects.link(root)
    root["source_ai"] = job["source_ai"]
    root["dimensions_mm"] = f"{width} x {depth} x {height}"

    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, height / 2.0))
    core = bpy.context.object
    core.name = f"{job['code']}_Box_Core"
    core.dimensions = (width, depth, height)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    core.data.materials.append(make_core_material())
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
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = int(job["render"]["resolution_x"])
    scene.render.resolution_y = int(job["render"]["resolution_y"])
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.image_settings.compression = 35
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -0.55
    scene.world.color = (1.0, 1.0, 1.0)

    world = scene.world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    background.inputs["Strength"].default_value = 0.62

    bpy.ops.mesh.primitive_plane_add(size=600, location=(0, 0, -0.8))
    floor = bpy.context.object
    floor.name = "White floor"
    floor_mat = bpy.data.materials.new("MAT_WhiteFloor")
    floor_mat.diffuse_color = (0.95, 0.95, 0.95, 1)
    floor_mat.use_nodes = True
    floor_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.96, 0.96, 0.96, 1)
    floor_mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.82
    floor_shader = floor_mat.node_tree.nodes["Principled BSDF"]
    if floor_shader.inputs.get("Emission Color"):
        floor_shader.inputs["Emission Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    if floor_shader.inputs.get("Emission Strength"):
        floor_shader.inputs["Emission Strength"].default_value = 3.0
    floor.data.materials.append(floor_mat)

    bpy.ops.mesh.primitive_plane_add(size=520, location=(0, 130, 145), rotation=(math.radians(90), 0, 0))
    backdrop = bpy.context.object
    backdrop.name = "White backdrop"
    backdrop.data.materials.append(floor_mat)

    bpy.ops.object.light_add(type="AREA", location=(-135, -190, 275))
    key = bpy.context.object
    key.name = "Key softbox"
    key.data.energy = 105000
    key.data.shape = "RECTANGLE"
    key.data.size = 120
    key.data.size_y = 150
    look_at(key, (0, 0, 90))

    bpy.ops.object.light_add(type="AREA", location=(155, -120, 175))
    fill = bpy.context.object
    fill.name = "Fill softbox"
    fill.data.energy = 62000
    fill.data.size = 110
    look_at(fill, (0, 0, 90))

    bpy.ops.object.light_add(type="AREA", location=(0, 15, 315))
    rim = bpy.context.object
    rim.name = "Rim softbox"
    rim.data.energy = 72000
    rim.data.size = 95
    look_at(rim, (0, 0, 90))

    bpy.ops.object.camera_add(location=(165, -260, 205))
    camera = bpy.context.object
    camera.name = "Product Camera"
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = float(job["render"]["camera_ortho_scale_mm"])
    camera.data.lens = 52
    look_at(camera, (0, 0, 88))
    scene.camera = camera
    return camera


def render_views(job, root):
    scene = bpy.context.scene
    outputs = job["outputs"]
    front_rotation = math.radians(float(job["render"].get("front_rotation_deg", 0)))
    back_rotation = math.radians(float(job["render"].get("back_rotation_deg", 180)))
    root.rotation_euler.z = front_rotation
    scene.render.filepath = outputs["front_right"]
    bpy.ops.render.render(write_still=True)

    root.rotation_euler.z = back_rotation
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
    bpy.ops.export_scene.gltf(
        filepath=job["outputs"]["glb"],
        export_format="GLB",
        use_selection=True,
        export_yup=True,
    )


def verify_glb(job):
    clean_scene()
    bpy.ops.import_scene.gltf(filepath=job["outputs"]["glb"])
    points = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    if not points:
        raise RuntimeError("GLB verification failed: no mesh objects")
    mins = [min(point[i] for point in points) for i in range(3)]
    maxs = [max(point[i] for point in points) for i in range(3)]
    measured_m = sorted([maxs[i] - mins[i] for i in range(3)])
    expected_mm = sorted(
        [
            float(job["dimensions_mm"]["width"]),
            float(job["dimensions_mm"]["depth"]),
            float(job["dimensions_mm"]["height"]),
        ]
    )
    measured_mm = [value * 1000.0 for value in measured_m]
    tolerance = float(job["glb_tolerance_mm"])
    errors = [abs(actual - expected) for actual, expected in zip(measured_mm, expected_mm)]
    if max(errors) > tolerance:
        raise RuntimeError(
            f"GLB dimension mismatch: measured={measured_mm}, expected={expected_mm}, tolerance={tolerance}"
        )
    return measured_mm, errors


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
    measured_mm, errors = verify_glb(job)
    result = {
        "code": job["code"],
        "outputs": job["outputs"],
        "glb_dimensions_mm_sorted": [round(value, 4) for value in measured_mm],
        "glb_dimension_error_mm_sorted": [round(value, 4) for value in errors],
        "render_resolution": [job["render"]["resolution_x"], job["render"]["resolution_y"]],
        "blender_elapsed_s": round(time.perf_counter() - started, 3),
    }
    result_path = Path(job["project_dir"]) / "blender_result.json"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
