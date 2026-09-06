"""Bounded RF-05 carton geometry, in millimetres, without a Blender dependency.

One closed paperboard shell avoids invented closure seams. Six artwork charts
cover the rounded outside without trimming their UV domain or painting borders.
The cavity is a second, inward-facing boundary, not a translucent solid block.
"""
import math
from collections import Counter
from itertools import product


SHELL_MODEL = "closed-carton-shell-v1"
FACES = ("front", "right", "back", "left", "top", "bottom")


def _positive(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"invalid {name}")
    return float(value)


def shell_parameters(dimensions, config=None):
    config = config or {}
    sizes = [_positive(dimensions[k], k) for k in ("width", "depth", "height")]
    shortest = min(sizes)
    thickness = min(_positive(config.get("thickness_mm", 0.4), "thickness"), shortest * 0.08)
    gap = min(_positive(config.get("surface_gap_mm", 0.002), "surface gap"), thickness * 0.05)
    radius = min(max(_positive(config.get("core_bevel_mm", 0.6), "bevel"), thickness * 1.5) + gap, shortest * 0.2)
    segments = config.get("bevel_segments", 4)
    if isinstance(segments, bool) or not isinstance(segments, int) or not 2 <= segments <= 4:
        raise ValueError("invalid bevel segments")
    return {"thickness_mm": thickness, "surface_gap_mm": gap, "core_bevel_mm": radius-gap, "outer_radius_mm": radius, "bevel_segments": segments}


def _source_point(face, u, v, sizes):
    w, d, h = sizes
    return {
        "front": ((u-.5)*w, -d/2, (v-.5)*h),
        "right": (w/2, (u-.5)*d, (v-.5)*h),
        "back": ((.5-u)*w, d/2, (v-.5)*h),
        "left": (-w/2, (.5-u)*d, (v-.5)*h),
        "top": ((u-.5)*w, (v-.5)*d, h/2),
        "bottom": ((u-.5)*w, (.5-v)*d, -h/2),
    }[face]


def surface_point(face, uv, sizes, radius, offset=0):
    source = _source_point(face, *uv, sizes)
    centre = [max(-s/2+radius, min(s/2-radius, p)) for s, p in zip(sizes, source)]
    delta = [p-c for p, c in zip(source, centre)]
    length = math.sqrt(sum(x*x for x in delta))
    normal = [x/length for x in delta]
    point = [c+(radius-offset)*n for c, n in zip(centre, normal)]
    point[2] += sizes[2]/2
    return point, normal


def _axis_grid(size, radius, segments):
    edge = [radius*i/(segments*size) for i in range(segments+1)]
    return edge + [1-x for x in reversed(edge)]


def carton_meshes(dimensions, config=None):
    parameters = shell_parameters(dimensions, config)
    sizes = [float(dimensions[k]) for k in ("width", "depth", "height")]
    radius, segments = parameters["outer_radius_mm"], parameters["bevel_segments"]
    axes = {"front": (0,2), "right": (1,2), "back": (0,2), "left": (1,2), "top": (0,1), "bottom": (0,1)}
    surfaces = {}
    core = {"vertices": [], "normals": [], "triangles": []}
    shared = {}
    for face in FACES:
        a, b = axes[face]
        us, vs = (_axis_grid(sizes[i], radius, segments) for i in (a,b))
        chart = {"vertices": [], "normals": [], "uvs": [], "triangles": []}
        remap = []
        for v in vs:
            for u in us:
                uv = [u,v]
                point, normal = surface_point(face, uv, sizes, radius)
                chart["vertices"].append(point)
                chart["normals"].append(normal)
                chart["uvs"].append(uv)
                key = tuple(round(x, 9) for x in point)
                if key not in shared:
                    shared[key] = len(core["vertices"])
                    core["vertices"].append([p-parameters["surface_gap_mm"]*n for p,n in zip(point, normal)])
                    core["normals"].append(normal)
                remap.append(shared[key])
        for j in range(len(vs)-1):
            for i in range(len(us)-1):
                a = j*len(us)+i
                b, c, d = a+1, a+len(us)+1, a+len(us)
                chart["triangles"].extend([[a,b,c], [a,c,d]])
        core["triangles"].extend([[remap[i] for i in tri] for tri in chart["triangles"]])
        surfaces[face] = chart
    count = len(core["vertices"])
    core["vertices"] += [[p-parameters["thickness_mm"]*n for p,n in zip(point, normal)] for point,normal in zip(core["vertices"], core["normals"])]
    core["normals"] += [[-n for n in normal] for normal in core["normals"]]
    core["triangles"] += [[i+count for i in reversed(tri)] for tri in core["triangles"]]
    return {"model": SHELL_MODEL, "parameters": parameters, "core": core, "surfaces": surfaces}


def _cycle(triangle):
    return min(tuple(triangle[i:]+triangle[:i]) for i in range(3))


def _match_triangles(observed, expected, tolerance):
    """Compare oriented, referenced topology; extras and spare vertices prove nothing."""
    buckets = {}
    for index, point in enumerate(expected["vertices"]):
        key = tuple(math.floor(x/tolerance) for x in point)
        buckets.setdefault(key, []).append(index)
    def identify(point):
        if len(point) != 3 or any(not math.isfinite(x) for x in point):
            raise ValueError("nonfinite shell vertex")
        key = tuple(math.floor(x/tolerance) for x in point)
        candidates = [i for shift in product((-1,0,1), repeat=3)
                      for i in buckets.get(tuple(a+b for a,b in zip(key, shift)), [])
                      if max(abs(a-b) for a,b in zip(point, expected["vertices"][i])) <= tolerance]
        if len(candidates) != 1:
            raise ValueError("shell position does not match declared geometry")
        return candidates[0]
    if len(observed) != len(expected["triangles"]):
        raise ValueError("incomplete shell triangles")
    actual = Counter(_cycle([identify(point) for point in triangle]) for triangle in observed)
    wanted = Counter(_cycle(tri) for tri in expected["triangles"])
    if actual != wanted:
        raise ValueError("shell topology or winding mismatch")


def compare_shell_surfaces(surfaces, dimensions, config):
    try:
        model = carton_meshes(dimensions, config)
        # glTF float32 roundoff, much smaller than the print/core separation.
        tolerance = max(float(v) for v in dimensions.values()) * 2e-7
        for face in FACES:
            samples = surfaces.get(face, [])
            expected = model["surfaces"][face]
            if len(samples) != len(expected["triangles"])*3:
                raise ValueError("incomplete curved artwork chart")
            sizes = [float(dimensions[k]) for k in ("width", "depth", "height")]
            for sample in samples:
                uv = sample["uv"]
                if len(uv) != 2 or any(not math.isfinite(v) or not -1e-6 <= v <= 1+1e-6 for v in uv):
                    raise ValueError("invalid shell UV")
                point, _ = surface_point(face, uv, sizes, model["parameters"]["outer_radius_mm"])
                if max(abs(p-q*1000) for p,q in zip(point, sample["position"])) > tolerance*2:
                    raise ValueError("shell UV direction, mirror or geometry mismatch")
            triangles = [[[p*1000 for p in s["position"]] for s in samples[i:i+3]] for i in range(0,len(samples),3)]
            _match_triangles(triangles, expected, tolerance)
        return {"ok": True, "model": SHELL_MODEL, "faces": list(FACES)}
    except (ValueError, TypeError, KeyError, IndexError, OverflowError) as error:
        return {"ok": False, "errors": [{"code": "carton_shell_surface_invalid", "detail": str(error)}]}


def compare_shell_core(cores, dimensions, config):
    try:
        if len(cores) != 1 or cores[0].get("materials") != ["MAT_PaperboardEdge"]:
            raise ValueError("one paperboard shell required")
        model = carton_meshes(dimensions, config)
        triangles = [[[p*1000 for p in point] for point in tri] for tri in cores[0]["triangles"]]
        _match_triangles(triangles, model["core"], max(float(v) for v in dimensions.values())*2e-7)
        return {"ok": True, "model": SHELL_MODEL, "parameters": model["parameters"]}
    except (ValueError, TypeError, KeyError, IndexError, OverflowError) as error:
        return {"ok": False, "errors": [{"code": "carton_shell_core_invalid", "detail": str(error)}]}
