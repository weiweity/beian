from __future__ import annotations

import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from copy import deepcopy

from PIL import Image
import pytest


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
REPO = PACKAGING.parents[1]
WRAPPER_PATH = PACKAGING / "tools" / "render_quality_experiment_blender.py"
DRIVER_PATH = PACKAGING / "tools" / "render_quality_experiment.py"
DECLARATION_PATH = PACKAGING / "fixtures" / "render-quality" / "experiments" / "rfe02-lighting.json"
MANIFEST_PATH = PACKAGING / "fixtures" / "render-quality" / "manifest.json"
RF00_BASELINE = PACKAGING / "fixtures" / "render-quality" / "baselines" / "rf00-current.json"
FORBIDDEN_CONTENT = (
    "达肤妍",
    "江华",
    "jianghua",
    "伸美",
    "刘籽烨",
    "weiweity",
    "客户稿",
    "商标",
)
TALL_DIMS = {"width": 40.0, "depth": 40.0, "height": 180.0}
WIDE_DIMS = {"width": 100.0, "depth": 50.0, "height": 30.0}
WHITE_DIMS = {"width": 47.5, "depth": 47.5, "height": 177.5}
DARK_DIMS = {"width": 47.5, "depth": 47.5, "height": 177.5}
ENERGY_SCALE = 4.0
REQUIRED_STILLS = (
    "front_right",
    "back_left",
    "front_right_ground",
    "back_left_ground",
    "front_right_set",
    "back_left_set",
)


def wrap_module():
    spec = importlib.util.spec_from_file_location("packaging_rfe02_wrap_test", WRAPPER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def driver_module():
    spec = importlib.util.spec_from_file_location("packaging_rfe02_driver_test", DRIVER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def control_light_dicts():
    return [
        {
            "name": "Key softbox",
            "location": (-135.0, -190.0, 275.0),
            "type": "AREA",
            "shape": "RECTANGLE",
            "size": 120.0,
            "size_y": 150.0,
            "energy": 105000.0 * ENERGY_SCALE,
            "color": (1.0, 1.0, 1.0),
        },
        {
            "name": "Fill softbox",
            "location": (155.0, -120.0, 175.0),
            "type": "AREA",
            "shape": "SQUARE",
            "size": 110.0,
            "energy": 62000.0 * ENERGY_SCALE,
            "color": (1.0, 1.0, 1.0),
        },
        {
            "name": "Rim softbox",
            "location": (-90.0, 210.0, 280.0),
            "type": "AREA",
            "shape": "RECTANGLE",
            "size": 70.0,
            "size_y": 40.0,
            "energy": 72000.0 * ENERGY_SCALE,
            "color": (1.0, 1.0, 1.0),
        },
    ]


class FakeLightData:
    def __init__(self, payload: dict):
        self.type = payload["type"]
        self.shape = payload.get("shape")
        self.size = payload["size"]
        self.size_y = payload.get("size_y")
        self.energy = payload["energy"]
        self.color = payload.get("color", (1.0, 1.0, 1.0))


class FakeLight:
    def __init__(self, payload: dict):
        self.name = payload["name"]
        self.location = tuple(payload["location"])
        self.rotation_euler = payload.get("rotation_euler", (0.0, 0.0, 0.0))
        self.type = "LIGHT"
        self.data = FakeLightData(payload)


def fake_lights():
    return [FakeLight(item) for item in control_light_dicts()]


class FakeInput:
    def __init__(self, value):
        self.default_value = value


class FakeNode:
    def __init__(self, node_type, inputs=None, image=None, name="node"):
        self.type = node_type
        self.inputs = inputs or {}
        self.image = image
        self.name = name


class FakeWorld:
    def __init__(self):
        self.color = (1.0, 1.0, 1.0)
        self.use_nodes = True
        self.node_tree = type(
            "Tree",
            (),
            {
                "nodes": [
                    FakeNode(
                        "BACKGROUND",
                        {
                            "Color": FakeInput((1.0, 1.0, 1.0, 1.0)),
                            "Strength": FakeInput(0.62),
                        },
                    )
                ]
            },
        )()


class FakeCamera:
    def __init__(self):
        self.matrix_world = [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]
        self.data = type("CamData", (), {"type": "ORTHO", "ortho_scale": 224.0})()


class FakeRender:
    def __init__(self):
        self.engine = "BLENDER_EEVEE_NEXT"
        self.resolution_x = 3000
        self.resolution_y = 3600
        self.resolution_percentage = 100
        self.film_transparent = True
        self.image_settings = type("Img", (), {"color_depth": "8", "color_mode": "RGBA"})()


class FakeRoot:
    def __init__(self):
        self.name = "rf00-wide-carton_Model_Root"
        self.rotation_euler = (0.0, 0.0, 0.25)
        self.matrix_world = [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]
        self.data = None


class FakeCore:
    def __init__(self):
        self.name = "rf00-wide-carton_Box_Core"
        self.dimensions = (100.0, 50.0, 30.0)
        self.data = type("Mesh", (), {"vertices": [0] * 8, "materials": []})()


class FakeScene:
    def __init__(self, *, eevee_samples=True):
        self.world = FakeWorld()
        self.camera = FakeCamera()
        self.render = FakeRender()
        self.view_settings = type(
            "View",
            (),
            {"view_transform": "Standard", "look": "None", "exposure": 0.0, "gamma": 1.0},
        )()
        if eevee_samples:
            self.eevee = type("Eevee", (), {"taa_render_samples": 64})()
        else:
            self.eevee = type("Eevee", (), {})()
        self.objects = [FakeRoot(), FakeCore()]


def measured(value, method="test"):
    return {"status": "measured", "value": value, "method": method}


def complete_pass(key: str, digest: str, nonce: str, *, extra=None) -> dict:
    payload = {
        "execution_nonce": nonce,
        "declaration_sha256": "a" * 64,
        "snapshot_sha256": "b" * 64,
        "variant": "control",
        "output_key": key,
        "lights": [{"name": "Key softbox"}],
        "lights_contract_ok": True,
        "world": {"background": {"strength": 0.62}},
        "camera": {"type": measured("ORTHO")},
        "object": {"yaw": measured(0.0)},
        "engine": {"engine": measured("BLENDER_EEVEE_NEXT")},
        "render": {
            "resolution_x": measured(3000),
            "resolution_y": measured(3600),
            "resolution_percentage": measured(100),
            "film_transparent": measured(True),
            "color_depth": measured("8"),
            "color_mode": measured("RGBA"),
            "view_transform": measured("Standard"),
            "look": measured("None"),
            "exposure": measured(0.0),
            "gamma": measured(1.0),
        },
        "pass_complete": True,
        "output_sha256": digest,
    }
    wrap = wrap_module()
    payload.update(wrap.capture_pass_scene(
        FakeScene(), path=Path('/synthetic') / (key + '.png'),
        job={'execution_nonce': nonce, 'outputs': {key: '/synthetic/' + key + '.png'}},
        lights=fake_lights(), variant='control', declaration_sha256='a' * 64,
        snapshot_sha256='b' * 64, source_identity=SOURCE_IDENTITY,
    ))
    payload['object']['materials'] = [{'name': 'paper', 'roughness': measured(0.52),
                                      'base_color': measured([0.7, 0.7, 0.7, 1.0])}]
    payload['object']['textures'] = [{'face': 'front', 'sha256': 'f' * 64}]
    payload.update(pass_complete=True, output_sha256=digest)
    if extra:
        payload.update(extra)
    return payload


SOURCE_IDENTITY = {key: 'c' * 64 for key in
                   ('wrapper_sha256', 'render_job_sha256', 'camera_frame_sha256', 'glb_verify_sha256')}


def test_decoder_source_is_bound_to_experiment_identity():
    driver = driver_module()
    expected = hashlib.sha256((PACKAGING / 'glb_verify.py').read_bytes()).hexdigest()
    assert driver.collect_experiment_identity()['glb_verify_sha256'] == expected
    assert driver.wrapper_module().source_identity_payload()['glb_verify_sha256'] == expected
    identity = dict(SOURCE_IDENTITY)
    identity.pop('glb_verify_sha256')
    assert not driver.wrapper_module().valid_source_identity(identity)


@pytest.mark.parametrize('path', [
    ('engine', 'samples'), ('render', 'resolution_x'), ('camera', 'matrix_world'),
    ('world', 'background'), ('object', 'geometry'), ('object', 'transform'),
])
@pytest.mark.parametrize('bad', [None, {'status': 'unavailable'}, {'status': 'measured', 'value': float('nan')}])
def test_required_evidence_fails_closed(path, bad):
    wrap = wrap_module()
    receipt = complete_pass('front_right', 'd' * 64, 'nonce')
    assert not wrap.pass_evidence_incomplete(receipt)
    if bad is None:
        receipt[path[0]].pop(path[1])
    else:
        receipt[path[0]][path[1]] = bad
    assert wrap.pass_evidence_incomplete(receipt)


@pytest.mark.parametrize('field', ['execution_nonce', 'variant', 'declaration_sha256',
                                  'snapshot_sha256', 'source_identity'])
@pytest.mark.parametrize('missing', [False, True])
def test_per_pass_identity_bound_to_job(tmp_path, field, missing):
    wrap = wrap_module()
    outputs = _job_outputs(tmp_path)
    passes = [complete_pass(key, write_still(Path(outputs[key])), 'current') for key in REQUIRED_STILLS]
    kwargs = dict(main_finished=True, variant='control', declaration_sha256='a'*64,
                  snapshot_sha256='b'*64, source_identity=SOURCE_IDENTITY,
                  blender_result={'execution_nonce': 'current'}, expected_nonce='current', outputs=outputs)
    assert wrap.finalize_job_receipt(passes=passes, **kwargs)['complete']
    if missing:
        passes[0].pop(field)
    else:
        passes[0][field] = 'different'
    assert not wrap.finalize_job_receipt(passes=passes, **kwargs)['complete']


def test_pair_rejects_missing_identity_and_same_pack():
    driver = driver_module()
    pack = {'passes': [complete_pass(key, 'd'*64, 'current') for key in REQUIRED_STILLS]}
    assert not driver.pairwise_check(pack, pack, fixture_id='rf00-wide-carton')['ok']


def test_other_worktree_and_alias_rejected(tmp_path, monkeypatch):
    driver = driver_module()
    # An explicit inventory fixture must work in CI's single-checkout clone too.
    # No .git marker: rejection must come from the discovered inventory itself.
    other = tmp_path / 'other-checkout'
    other.mkdir()
    others = [other]
    inventory = os.fsencode(f'worktree {REPO}\0\0worktree {other}\0\0')
    def inventory_command(args, **kwargs):
        assert args == ['git', '-C', str(driver.REPO_ROOT), 'worktree', 'list', '--porcelain', '-z']
        return subprocess.CompletedProcess(args, 0, stdout=inventory, stderr=b'')
    monkeypatch.setattr(driver.subprocess, 'run', inventory_command)
    link = tmp_path / 'other-tree'
    link.symlink_to(others[0], target_is_directory=True)
    for root in [*others, link, Path(str(others[0]).swapcase())]:
        with pytest.raises(driver.wrapper_module().ExperimentError):
            driver.assert_experiment_root_allowed(root / 'new-output')


def test_single_checkout_inventory_allows_isolated_output(tmp_path, monkeypatch):
    driver = driver_module()
    monkeypatch.setattr(driver.subprocess, 'run', lambda args, **kwargs:
                        subprocess.CompletedProcess(args, 0, stdout=os.fsencode(f'worktree {REPO}\0\0'), stderr=b''))
    assert driver.assert_experiment_root_allowed(tmp_path / 'new-output') == (tmp_path / 'new-output').resolve()


def test_worktree_inventory_failure_creates_nothing(monkeypatch):
    driver = driver_module()
    def fail(*args, **kwargs):
        raise subprocess.TimeoutExpired('git', 5)
    def forbidden(*args, **kwargs):
        pytest.fail('must validate temporary parent before mkdir')
    monkeypatch.setattr(driver.subprocess, 'run', fail)
    monkeypatch.setattr(driver.tempfile, 'mkdtemp', forbidden)
    with pytest.raises(driver.wrapper_module().ExperimentError, match='worktree_inventory_unavailable'):
        driver.create_experiment_root()


@pytest.mark.parametrize('field,bad', [('resolution_x', True), ('resolution_y', 0),
                                    ('exposure', 'bright'), ('gamma', float('inf'))])
def test_render_measurement_value_types(field, bad):
    wrap = wrap_module()
    receipt = complete_pass('front_right', 'd'*64, 'nonce')
    receipt['render'][field]['value'] = bad
    assert wrap.pass_evidence_incomplete(receipt)


def write_still(path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGBA", (16, 16), (12, 24, 36, 255)).save(path)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rfe02_tmp_dirs() -> set[str]:
    names: set[str] = set()
    for root in {Path("/tmp"), Path(tempfile.gettempdir())}:
        if not root.is_dir():
            continue
        try:
            for item in root.iterdir():
                if item.name.startswith("beian-rfe02-"):
                    names.add(str(item.resolve()) if item.exists() else item.name)
        except OSError:
            continue
    return names


# --- 1. pure parameter transform -------------------------------------------------


def test_tall_identity_wide_changes_and_energy_scale_formula():
    wrap = wrap_module()
    lights = control_light_dicts()
    tall = wrap.candidate_light_params(TALL_DIMS, lights)
    assert wrap.scale_factor(40.0, 40.0, 180.0) == 1.0
    assert wrap.target_from_height(180.0) == (0.0, 0.0, 90.0)
    for src, got in zip(lights, tall, strict=True):
        assert got["name"] == src["name"]
        assert got["location"] == pytest.approx(list(src["location"]))
        assert got["size"] == pytest.approx(src["size"])
        if src["name"] == "Fill softbox":
            assert got["size_y"] is None
        else:
            assert got["size_y"] == pytest.approx(src["size_y"])
        assert got["energy"] == pytest.approx(src["energy"])
        assert got["color"] == list(src["color"])
        assert got["type"] == "AREA"
        assert got["shape"] == src["shape"]
    assert wrap.lights_are_identity(
        [
            {
                "name": item["name"],
                "location": item["location"],
                "size": item["size"],
                "size_y": item.get("size_y"),
                "energy": item["energy"],
            }
            for item in lights
        ],
        [
            {
                "name": item["name"],
                "location": item["location"],
                "size": item["size"],
                "size_y": item.get("size_y"),
                "energy": item["energy"],
            }
            for item in tall
        ],
    )

    scale = 100.0 / 180.0
    wide = wrap.candidate_light_params(WIDE_DIMS, lights)
    assert wide[0]["scale"] == pytest.approx(scale)
    expected = wrap.transform_location((-135.0, -190.0, 275.0), scale, (0.0, 0.0, 15.0))
    assert wide[0]["location"] == pytest.approx(list(expected))
    assert wide[0]["size"] == pytest.approx(120.0 * scale)
    assert wide[0]["size_y"] == pytest.approx(150.0 * scale)
    assert wide[0]["energy"] == pytest.approx(lights[0]["energy"] * scale * scale)
    assert wide[1]["size"] == pytest.approx(110.0 * scale)
    assert wide[1]["size_y"] is None
    assert wide[0]["location"] != pytest.approx(list(lights[0]["location"]))
    assert not wrap.lights_are_identity(
        [{"name": "Key softbox", "location": lights[0]["location"], "size": 120.0, "size_y": 150.0, "energy": lights[0]["energy"]}],
        [{"name": "Key softbox", "location": wide[0]["location"], "size": wide[0]["size"], "size_y": wide[0]["size_y"], "energy": wide[0]["energy"]}],
    )


def test_same_size_white_and_dark_share_candidate_params():
    wrap = wrap_module()
    lights = control_light_dicts()
    white = wrap.candidate_light_params(WHITE_DIMS, lights)
    dark = wrap.candidate_light_params(DARK_DIMS, lights)
    assert white == dark
    assert inspect.signature(wrap.candidate_light_params).parameters.keys() == {"dimensions", "lights"}
    assert "color" not in inspect.signature(wrap.apply_normalized_rig).parameters
    assert "fill_rgb" not in inspect.signature(wrap.apply_normalized_rig).parameters


# --- 2. invalid inputs; no color routing -----------------------------------------


def test_invalid_variant_dimensions_missing_and_wrong_light_types_fail():
    wrap = wrap_module()
    with pytest.raises(wrap.ExperimentError, match="unsupported lighting variant"):
        wrap.validate_variant("hdr")
    with pytest.raises(wrap.ExperimentError, match="finite positive"):
        wrap.validate_dimensions({"width": True, "depth": 40.0, "height": 50.0})
    with pytest.raises(wrap.ExperimentError, match="finite positive"):
        wrap.validate_dimensions({"width": 40.0, "depth": float("nan"), "height": 50.0})
    with pytest.raises(wrap.ExperimentError, match="finite positive"):
        wrap.validate_dimensions({"width": 40.0, "depth": 40.0, "height": float("inf")})
    with pytest.raises(wrap.ExperimentError, match="missing"):
        wrap.validate_dimensions({"width": 40.0, "depth": 40.0})
    lights = fake_lights()
    with pytest.raises(wrap.ExperimentError, match="exactly three"):
        wrap.validate_studio_lights(lights[:2])
    lights[0].data.type = "SUN"
    with pytest.raises(wrap.ExperimentError, match="must be AREA"):
        wrap.apply_normalized_rig(lights, WIDE_DIMS, lambda *_args: None)


# --- 3. control once; B only light whitelist -------------------------------------


def test_control_add_studio_called_once_without_light_edits():
    wrap = wrap_module()
    lights = fake_lights()
    before = [(item.name, tuple(item.location), item.data.energy, item.data.color, item.data.type, item.data.shape) for item in lights]
    looks = []
    ctx = wrap.ExperimentContext(
        variant="control",
        declaration_sha256="a" * 64,
        snapshot_sha256="b" * 64,
        source_identity={},
        list_lights=lambda: lights,
        look_at=lambda obj, target: looks.append((obj.name, tuple(target))),
    )
    calls = {"n": 0}

    def original(job):
        calls["n"] += 1
        return "camera"

    wrapped = wrap.make_add_studio(original, ctx)
    assert wrapped({"dimensions_mm": WIDE_DIMS}) == "camera"
    assert calls["n"] == 1
    assert ctx.add_studio_calls == 1
    assert looks == []
    after = [(item.name, tuple(item.location), item.data.energy, item.data.color, item.data.type, item.data.shape) for item in lights]
    assert after == before


def test_normalized_rig_only_changes_light_whitelist():
    wrap = wrap_module()
    lights = fake_lights()
    colors = [item.data.color for item in lights]
    types = [item.data.type for item in lights]
    shapes = [item.data.shape for item in lights]
    names = [item.name for item in lights]
    looks = []

    def look_at(obj, target):
        looks.append((obj.name, tuple(target)))
        obj.rotation_euler = (0.2, 0.1, 0.0)

    ctx = wrap.ExperimentContext(
        variant="normalized-rig-v1",
        declaration_sha256="a" * 64,
        snapshot_sha256="b" * 64,
        source_identity={},
        list_lights=lambda: lights,
        look_at=look_at,
    )
    calls = {"n": 0}

    def original(job):
        calls["n"] += 1
        return "camera"

    wrapped = wrap.make_add_studio(original, ctx)
    wrapped({"dimensions_mm": WIDE_DIMS})
    assert calls["n"] == 1
    assert [item.name for item in lights] == names
    assert [item.data.color for item in lights] == colors
    assert [item.data.type for item in lights] == types
    assert [item.data.shape for item in lights] == shapes
    assert tuple(lights[0].location) != (-135.0, -190.0, 275.0)
    assert lights[0].data.energy != 105000.0 * ENERGY_SCALE
    assert looks
    assert looks[0][1] == pytest.approx((0.0, 0.0, 15.0))


# --- 4. complete only after original main / nonce / hashes -----------------------


def _job_outputs(tmp_path: Path) -> dict[str, str]:
    outputs = {}
    for key in REQUIRED_STILLS:
        outputs[key] = str(tmp_path / f"{key}.png")
    outputs["blend"] = str(tmp_path / "scene.blend")
    outputs["glb"] = str(tmp_path / "model.glb")
    return outputs


def test_finalize_rejects_incomplete_nonce_hash_and_missing_passes(tmp_path: Path):
    wrap = wrap_module()
    outputs = _job_outputs(tmp_path)
    digests = {key: write_still(Path(path)) for key, path in outputs.items() if key in REQUIRED_STILLS}
    nonce = "nonce-current"
    passes = [complete_pass(key, digests[key], nonce) for key in REQUIRED_STILLS]
    ok = wrap.finalize_job_receipt(
        main_finished=True,
        variant="control",
        declaration_sha256="a" * 64,
        snapshot_sha256="b" * 64,
        source_identity=SOURCE_IDENTITY,
        passes=passes,
        blender_result={"execution_nonce": nonce},
        expected_nonce=nonce,
        outputs=outputs,
    )
    assert ok["complete"] is True
    assert ok["quality_improvement"] == wrap.NOT_ASSESSED
    assert ok["candidate_is_product_profile"] is False
    assert ok["browser"]["status"] == "not_measured"
    assert ok["font_mapping"]["status"] == "not_measured"

    before_main = wrap.finalize_job_receipt(
        main_finished=False,
        variant="control",
        declaration_sha256="a" * 64,
        snapshot_sha256="b" * 64,
        source_identity={},
        passes=passes,
        blender_result={"execution_nonce": nonce},
        expected_nonce=nonce,
        outputs=outputs,
    )
    assert before_main["complete"] is False

    stale = wrap.finalize_job_receipt(
        main_finished=True,
        variant="control",
        declaration_sha256="a" * 64,
        snapshot_sha256="b" * 64,
        source_identity={},
        passes=passes,
        blender_result={"execution_nonce": "old-nonce"},
        expected_nonce=nonce,
        outputs=outputs,
    )
    assert stale["complete"] is False
    assert stale["nonce_ok"] is False

    mismatched = [complete_pass(key, "0" * 64, nonce) for key in REQUIRED_STILLS]
    bad_hash = wrap.finalize_job_receipt(
        main_finished=True,
        variant="normalized-rig-v1",
        declaration_sha256="a" * 64,
        snapshot_sha256="b" * 64,
        source_identity={},
        passes=mismatched,
        blender_result={"execution_nonce": nonce},
        expected_nonce=nonce,
        outputs=outputs,
    )
    assert bad_hash["complete"] is False
    assert bad_hash["experimental_scene_override"] is True

    Path(outputs["front_right_ground"]).unlink()
    missing_ground = wrap.finalize_job_receipt(
        main_finished=True,
        variant="control",
        declaration_sha256="a" * 64,
        snapshot_sha256="b" * 64,
        source_identity={},
        passes=passes,
        blender_result={"execution_nonce": nonce},
        expected_nonce=nonce,
        outputs=outputs,
    )
    assert missing_ground["complete"] is False
    assert missing_ground["outputs_closed"] is False

    incomplete_attr = complete_pass("front_right", digests["front_right"], nonce)
    incomplete_attr["render"]["resolution_x"] = wrap.unavailable("resolution_x_unreadable", method="scene.render.resolution_x")
    assert wrap.pass_evidence_incomplete(incomplete_attr) is True
    missing_pass = wrap.finalize_job_receipt(
        main_finished=True,
        variant="control",
        declaration_sha256="a" * 64,
        snapshot_sha256="b" * 64,
        source_identity={},
        passes=[complete_pass("front_right", digests["front_right"], nonce)],
        blender_result={"execution_nonce": nonce},
        expected_nonce=nonce,
        outputs=outputs,
    )
    assert missing_pass["complete"] is False
    assert missing_pass["evidence_insufficient"] is True
    assert "front_right_ground" in missing_pass["missing_required_passes"]


def test_render_still_failure_is_not_complete(tmp_path: Path):
    wrap = wrap_module()
    lights = fake_lights()
    dest = tmp_path / "front_right.png"
    job = {
        "execution_nonce": "n1",
        "dimensions_mm": WIDE_DIMS,
        "outputs": {"front_right": str(dest)},
        "assets": {},
    }
    ctx = wrap.ExperimentContext(
        variant="control",
        declaration_sha256="a" * 64,
        snapshot_sha256="b" * 64,
        source_identity={"wrapper_sha256": "c" * 64},
        list_lights=lambda: lights,
        look_at=lambda *_args: None,
        job=job,
    )

    def boom(_scene, _path):
        raise RuntimeError("ground pass failed")

    wrapped = wrap.make_render_still(boom, ctx)
    with pytest.raises(RuntimeError, match="ground pass failed"):
        wrapped(FakeScene(), dest)
    assert ctx.passes[0]["pass_complete"] is False
    assert ctx.passes[0]["error_type"] == "RuntimeError"
    assert dest.exists() is False


def test_capture_engine_missing_samples_are_unavailable_not_backfilled():
    wrap = wrap_module()
    captured = wrap.capture_engine(FakeScene(eevee_samples=False))
    assert captured["engine"]["status"] == "measured"
    assert captured["samples"]["status"] == "unavailable"
    assert "taa" in captured["samples"]["reason"] or "missing" in captured["samples"]["reason"]
    assert captured["samples"].get("value") not in {64, 0}


# --- 5. dry-run / import / missing blender ---------------------------------------


def test_import_has_no_filesystem_env_or_blender_side_effects():
    env_before = dict(os.environ)
    existing = rfe02_tmp_dirs()
    wrap = wrap_module()
    driver = driver_module()
    assert "bpy" not in wrap.__dict__
    assert os.environ == env_before
    assert rfe02_tmp_dirs() == existing
    assert driver.ENV_JOB not in os.environ or os.environ.get(driver.ENV_JOB) == env_before.get(driver.ENV_JOB)


def test_dry_run_emits_plan_without_writes_or_blender():
    driver = driver_module()
    env_before = dict(os.environ)
    existing = rfe02_tmp_dirs()
    report = driver.run_experiment(suite="smoke", render=False)
    assert report["ok"] is True
    assert report["render"] is False
    assert report["wrote_files"] is False
    assert report["blender_subprocess_invoked"] is False
    assert report["jobs"][0]["fixture_id"] == "rf00-wide-carton"
    assert report["jobs"][0]["variant"] == "control"
    assert report["jobs"][1]["variant"] == "normalized-rig-v1"
    assert report["quality_improvement"] == "not_assessed"
    assert report["candidate_is_product_profile"] is False
    assert os.environ == env_before
    assert rfe02_tmp_dirs() == existing
    proc = subprocess.run(
        [sys.executable, str(DRIVER_PATH), "--suite", "smoke"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0
    printed = json.loads(proc.stdout)
    assert printed["render"] is False
    assert printed["wrote_files"] is False
    assert rfe02_tmp_dirs() == existing


def test_missing_blender_fails_closed_without_samples(tmp_path: Path):
    driver = driver_module()
    existing = rfe02_tmp_dirs()
    baseline_before = RF00_BASELINE.read_bytes() if RF00_BASELINE.exists() else None
    report = driver.run_experiment(
        suite="smoke",
        render=True,
        blender_executable=tmp_path / "no-such-blender",
    )
    assert report["ok"] is False
    assert report["complete"] is False
    assert report["samples_written"] is False
    assert report["blender_subprocess_invoked"] is False
    assert report["failure_reason"] == "blender_executable_missing"
    assert report.get("improvement_passed") is not True
    assert rfe02_tmp_dirs() == existing
    if baseline_before is None:
        assert not RF00_BASELINE.exists()
    else:
        assert RF00_BASELINE.read_bytes() == baseline_before
    proc = subprocess.run(
        [
            sys.executable,
            str(DRIVER_PATH),
            "--suite",
            "smoke",
            "--render",
            "--blender",
            str(tmp_path / "missing-blender"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "blender_executable_missing" in proc.stdout
    assert "pip install" not in proc.stdout
    assert rfe02_tmp_dirs() == existing


def test_cli_has_no_output_dir_or_manifest_and_no_improvement_label():
    proc = subprocess.run(
        [sys.executable, str(DRIVER_PATH), "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0
    assert "--render" in proc.stdout
    assert "--suite" in proc.stdout
    assert "--output-dir" not in proc.stdout
    assert "--manifest" not in proc.stdout
    driver_text = DRIVER_PATH.read_text(encoding="utf-8")
    wrap_text = WRAPPER_PATH.read_text(encoding="utf-8")
    for token in ("update_baseline", "maybe_write_approved_baseline", "rf00-report", "improvement passed"):
        assert token not in driver_text
        assert token not in wrap_text


# --- 6. temp isolation ------------------------------------------------------------


def test_experiment_root_rejects_worktree_data_symlink_and_casefold(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    driver = driver_module()
    wrap = driver.wrapper_module()
    with pytest.raises(wrap.ExperimentError, match="repository worktree"):
        driver.assert_experiment_root_allowed(REPO / "docs")
    mixed = Path(str(REPO / "docs").swapcase())
    with pytest.raises(wrap.ExperimentError, match="repository worktree"):
        driver.assert_experiment_root_allowed(mixed)
    link = tmp_path / "repo-link"
    link.symlink_to(REPO, target_is_directory=True)
    with pytest.raises(wrap.ExperimentError, match="repository worktree"):
        driver.assert_experiment_root_allowed(link / "workers")
    data = tmp_path / "product-data"
    data.mkdir()
    monkeypatch.setenv("WB_DATA_DIR", str(data))
    with pytest.raises(wrap.ExperimentError, match="product data root"):
        driver.assert_experiment_root_allowed(data)
    with pytest.raises(wrap.ExperimentError, match="product data root"):
        driver.assert_experiment_root_allowed(data / "jobs")
    data_link = tmp_path / "data-link"
    data_link.symlink_to(data, target_is_directory=True)
    with pytest.raises(wrap.ExperimentError, match="product data root"):
        driver.assert_experiment_root_allowed(data_link / "jobs")
    swapped_data = Path(str(data).swapcase())
    with pytest.raises(wrap.ExperimentError, match="product data root"):
        driver.assert_experiment_root_allowed(swapped_data)
    with pytest.raises(wrap.ExperimentError, match="product task data directory"):
        driver.assert_experiment_root_allowed(Path("/tmp/apps/web/backend/data/rfe02-trap"))

    trap = REPO / "beian-rfe02-trap-should-not-remain"
    if trap.exists():
        trap.rmdir() if trap.is_dir() and not any(trap.iterdir()) else None

    def fake_mkdtemp(prefix=""):
        path = REPO / f"{prefix}trap-should-not-remain"
        path.mkdir()
        return str(path)

    monkeypatch.setattr(driver.tempfile, "mkdtemp", fake_mkdtemp)
    with pytest.raises(wrap.ExperimentError, match="repository worktree"):
        driver.create_experiment_root()
    assert not (REPO / "beian-rfe02-trap-should-not-remain").exists()


def test_create_experiment_root_is_outside_repo_and_uses_prefix():
    driver = driver_module()
    root = driver.create_experiment_root()
    try:
        assert root.name.startswith("beian-rfe02-")
        assert not driver._is_within(root, REPO)
        assert root.is_dir()
    finally:
        root.rmdir()


# --- 7. pipeline script / env / timeout restore ----------------------------------


class _SubprocessBox:
    def __init__(self, run):
        self.run = run


class _PipelineBox:
    def __init__(self, run):
        self.BLENDER_SCRIPT = Path("/original/render_job.py")
        self.subprocess = _SubprocessBox(run)


def test_experiment_runtime_restores_script_env_and_run_on_success_and_error(tmp_path: Path):
    driver = driver_module()
    wrap = driver.wrapper_module()
    envelope = tmp_path / "envelope.json"
    envelope.write_text("{}", encoding="utf-8")
    seen = {}

    def ok_run(*_args, **kwargs):
        seen["timeout"] = kwargs.get("timeout")
        return subprocess.CompletedProcess(["blender"], 0, "", "")

    pipeline = _PipelineBox(ok_run)
    original_script = pipeline.BLENDER_SCRIPT
    env_before = os.environ.get(driver.ENV_JOB)
    with driver.experiment_runtime(pipeline, envelope, time.monotonic() + 1000):
        assert pipeline.BLENDER_SCRIPT == driver.WRAPPER_PATH
        assert os.environ[driver.ENV_JOB] == str(envelope)
        pipeline.subprocess.run(["blender"])
    assert pipeline.BLENDER_SCRIPT == original_script
    assert pipeline.subprocess.run is ok_run
    assert os.environ.get(driver.ENV_JOB) == env_before
    assert seen["timeout"] == pytest.approx(min(180.0, 1000.0)) or seen["timeout"] <= 180

    pipeline = _PipelineBox(ok_run)
    try:
        with driver.experiment_runtime(pipeline, envelope, time.monotonic() + 1000):
            raise RuntimeError("boom")
    except RuntimeError:
        pass
    assert pipeline.BLENDER_SCRIPT == original_script
    assert pipeline.subprocess.run is ok_run
    assert os.environ.get(driver.ENV_JOB) == env_before

    with pytest.raises(wrap.ExperimentError, match="experiment_round_timeout"):
        with driver.experiment_runtime(pipeline, envelope, time.monotonic() - 1):
            pipeline.subprocess.run(["blender"])
    assert pipeline.BLENDER_SCRIPT == original_script


def test_timeout_does_not_kill_unrelated_process(tmp_path: Path):
    driver = driver_module()
    wrap = driver.wrapper_module()
    envelope = tmp_path / "envelope.json"
    envelope.write_text("{}", encoding="utf-8")

    def boom_run(*_args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="blender", timeout=kwargs.get("timeout", 1))

    pipeline = _PipelineBox(boom_run)
    sentinel = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        with pytest.raises(wrap.ExperimentError, match="blender_job_timeout"):
            with driver.experiment_runtime(pipeline, envelope, time.monotonic() + 1000):
                pipeline.subprocess.run(["blender"])
        assert sentinel.poll() is None
        assert pipeline.subprocess.run is boom_run
        assert "killall" not in DRIVER_PATH.read_text(encoding="utf-8")
        assert "killall" not in WRAPPER_PATH.read_text(encoding="utf-8")
    finally:
        sentinel.kill()
        sentinel.wait()


# --- 8. identity / pairwise / unmeasured browser ---------------------------------


def test_pairwise_rejects_non_light_and_input_drift():
    driver = driver_module()
    wrap = driver.wrapper_module()
    nonce = "n"
    control_pass = complete_pass("front_right", "d" * 64, nonce)
    candidate_pass = complete_pass("front_right", "e" * 64, nonce)
    for key in REQUIRED_STILLS:
        if key == "front_right":
            continue
        control_pass_extra = complete_pass(key, "d" * 64, nonce)
        candidate_pass_extra = complete_pass(key, "e" * 64, nonce)
        control_pass.setdefault("_all", [])
        candidate_pass.setdefault("_all", [])

    def pack(front, clone_src):
        items = [front]
        for key in REQUIRED_STILLS:
            if key == "front_right":
                continue
            items.append(complete_pass(key, clone_src, nonce))
        return items

    control = {
        "input_sha256": "1" * 64,
        "artwork_sha256": "2" * 64,
        "texture_sha256": "3" * 64,
        "passes": pack(control_pass, "d" * 64),
    }
    candidate = {
        "input_sha256": "1" * 64,
        "artwork_sha256": "2" * 64,
        "texture_sha256": "3" * 64,
        "passes": pack(candidate_pass, "e" * 64),
    }
    control.update(variant='control', complete=True)
    candidate.update(variant='normalized-rig-v1', complete=True)
    params = wrap.candidate_light_params(WIDE_DIMS, control_light_dicts())
    for p in candidate['passes']:
        p.update(variant='normalized-rig-v1', execution_nonce='candidate-nonce', snapshot_sha256='e'*64)
        p['lights'] = [wrap.snapshot_light_state(FakeLight(item)) for item in params]
    assert driver.pairwise_check(control, candidate, fixture_id='rf00-wide-carton')['ok']
    for field in ('input_sha256', 'artwork_sha256', 'texture_sha256'):
        left, right = deepcopy(control), deepcopy(candidate)
        left.pop(field)
        right.pop(field)
        assert not driver.pairwise_check(left, right, fixture_id='rf00-wide-carton')['ok']
    assert not driver.pairwise_check(control, control, fixture_id='rf00-wide-carton')['ok']
    duplicate = deepcopy(candidate)
    duplicate['passes'][1] = deepcopy(duplicate['passes'][0])
    assert not driver.pairwise_check(control, duplicate, fixture_id='rf00-wide-carton')['ok']
    stale = deepcopy(candidate)
    stale['passes'][1]['execution_nonce'] = 'old'
    assert not driver.pairwise_check(control, stale, fixture_id='rf00-wide-carton')['ok']
    drifted = driver.pairwise_check(control, {**candidate, "input_sha256": "9" * 64}, fixture_id="rf00-wide-carton")
    assert drifted["ok"] is False
    assert "input_sha256" in drifted["failures"]
    assert drifted["quality_improvement"] == wrap.NOT_ASSESSED

    changed_world = json.loads(json.dumps(candidate))
    changed_world["passes"][0]["world"]["background"]["strength"] = 0.99
    non_light = driver.pairwise_check(control, changed_world, fixture_id="rf00-wide-carton")
    assert non_light["ok"] is False
    assert any(item.startswith("non_light:") for item in non_light["failures"])


def test_type_frequency_chain_stays_unregistered_and_unmeasured(tmp_path: Path):
    driver = driver_module()
    wrap = driver.wrapper_module()
    eval_spec = importlib.util.spec_from_file_location(
        "packaging_render_quality_eval_rfe02_test",
        PACKAGING / "tools" / "render_quality_eval.py",
    )
    assert eval_spec and eval_spec.loader
    eval_mod = importlib.util.module_from_spec(eval_spec)
    eval_spec.loader.exec_module(eval_mod)
    full = tmp_path / "full.png"
    card = tmp_path / "card.png"
    Image.new("RGBA", (64, 48), (200, 200, 200, 255)).save(full)
    Image.new("RGBA", (32, 24), (200, 200, 200, 255)).save(card)
    spec = {
        "id": "rf00-type-frequency",
        "artwork": {
            "pattern": "type_frequency",
            "type_roi_mm": {"text": [1.2, 1.0, 48.8, 9.5], "barcode": [1.2, 11.0, 48.4, 26.0]},
        },
        "dimensions_mm": {"width": 50.0, "depth": 40.0, "height": 80.0},
    }
    chain = driver.type_frequency_chain(
        spec,
        artwork_pdf=None,
        panel=None,
        full=full,
        card=card,
        eval_mod=eval_mod,
    )
    assert chain["full"]["status"] == "unregistered"
    assert chain["card"]["status"] == "unregistered"
    assert chain["readability"] == wrap.NOT_ASSESSED
    assert chain["barcode_scannability"] == wrap.NOT_ASSESSED
    assert chain["find_edges_not_used_as_acceptance"] is True
    assert chain["browser"]["status"] == "not_measured"
    assert chain["font_mapping"]["status"] == "not_measured"
    assert "FIND_EDGES" not in json.dumps(chain)


def test_type_frequency_pdf_roi_uses_front_page_offset(tmp_path: Path):
    import pymupdf

    driver = driver_module()
    eval_spec = importlib.util.spec_from_file_location("rf00_roi_test", PACKAGING / "tools" / "render_quality_eval.py")
    eval_mod = importlib.util.module_from_spec(eval_spec)
    eval_spec.loader.exec_module(eval_mod)
    spec = {"id": "rf00-type-frequency", "dimensions_mm": {"width": 50, "depth": 40, "height": 80},
            "artwork": {"pattern": "type_frequency", "fill_rgb": [230, 230, 230]}}
    pdf = tmp_path / "artwork.pdf"
    eval_mod.write_artwork_pdf(spec, pdf)
    chain = driver.type_frequency_chain(spec, artwork_pdf=pdf, panel=None, full=None, card=None, eval_mod=eval_mod)
    crop = chain["pdf"]["text"]["crop_px"]
    # Compare the reported crop against independent PDF text extraction, not a copied transform.
    with pymupdf.open(pdf) as doc:
        scale_x = chain["pdf"]["raster_px"][0] / doc[0].rect.width
        scale_y = chain["pdf"]["raster_px"][1] / doc[0].rect.height
        clip = pymupdf.Rect(crop[0] / scale_x, crop[1] / scale_y, crop[2] / scale_x, crop[3] / scale_y)
        text = doc[0].get_text(clip=clip)
    assert "RF00 4PT SAMPLE" in text
    assert "RF00 6PT HAIRLINE" in text
    assert chain["pdf"]["raster_purpose"] == "diagnostic_only_not_pipeline_input"
    assert chain["pdf"]["front_origin_mm"] == [90.0, 40.0]


def test_identity_change_during_render_fails_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    driver = driver_module()
    wrap = driver.wrapper_module()
    blender = tmp_path / "blender"
    blender.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    blender.chmod(0o700)
    calls = {"n": 0}

    def flipping_identity():
        calls["n"] += 1
        return {"marker": "before" if calls["n"] == 1 else "after"}

    class FakePipeline:
        def __init__(self):
            self.BLENDER_SCRIPT = Path("/original/render_job.py")
            self.subprocess = _SubprocessBox(
                lambda *_a, **_k: subprocess.CompletedProcess(["blender"], 0, "", "")
            )

        @staticmethod
        def preflight_product(product, manifest_dir, _output_root, *_args):
            dest = Path(manifest_dir)
            assets = {}
            for face in ('front', 'right', 'back', 'left', 'top', 'bottom'):
                panel = dest / f'panel_{face}.png'
                write_still(panel)
                assets[face] = str(panel)
            return {
                "project_dir": str(dest),
                "outputs": {key: str(dest / f"{key}.png") for key in REQUIRED_STILLS},
                "assets": assets,
                "dimensions_mm": WIDE_DIMS,
            }

        @staticmethod
        def run_blender_job(job, executable):
            assert Path(executable) == blender
            raise RuntimeError("harness-not-blender")

    monkeypatch.setattr(driver, "collect_experiment_identity", flipping_identity)
    report = None
    try:
        report = driver.run_experiment(
            suite="smoke",
            render=True,
            blender_executable=blender,
            pipeline=FakePipeline(),
        )
        assert report["ok"] is False
        assert report["failure_reason"] == "identity_changed_during_run"
        assert report["identity_verified_after_run"] is False
        assert report.get("improvement_passed") is False
        assert report["quality_improvement"] == wrap.NOT_ASSESSED
        assert report["blender_subprocess_invoked"] is True
        assert "measured" not in str(report.get("blender", "")).lower() or report["ok"] is False
    finally:
        if report and report.get("root"):
            import shutil

            shutil.rmtree(report["root"], ignore_errors=True)


# --- 9. contact sheet scaling / no improvement label -----------------------------


def test_contain_size_never_upsamples_and_contact_sheet_shares_background(tmp_path: Path):
    driver = driver_module()
    wrap = driver.wrapper_module()
    assert driver.contain_size((32, 32), (480, 576)) == (32, 32, 1.0)
    fitted_w, fitted_h, scale = driver.contain_size((960, 1152), (480, 576))
    assert scale == pytest.approx(0.5)
    assert fitted_w == 480
    assert fitted_h == 576
    small = tmp_path / "small.png"
    large = tmp_path / "large.png"
    Image.new("RGBA", (32, 32), (10, 20, 30, 255)).save(small)
    Image.new("RGBA", (64, 48), (40, 50, 60, 255)).save(large)
    dest = tmp_path / "contact-sheet.png"
    result = driver.write_contact_sheet(
        [("rf00-wide-carton", small, large, (32, 32), (64, 48))],
        dest,
    )
    assert result["status"] == "measured"
    with Image.open(dest) as sheet:
        assert sheet.size[0] == 480 * 2
        assert sheet.size[1] == 576 + 28
        corner = sheet.getpixel((0, 40))
        assert corner[:3] == driver.SHEET_BG[:3]
        other = sheet.getpixel((480, 40))
        assert other[:3] == driver.SHEET_BG[:3]
    empty = driver.write_contact_sheet([], tmp_path / "missing.png")
    assert empty["status"] == "unavailable"
    assert "improve" not in json.dumps(empty).lower()
    assert wrap.NOT_ASSESSED == "not_assessed"


@pytest.mark.parametrize("alpha", [0, 1, 128, 254, 255])
@pytest.mark.parametrize("white_observe", [False, True])
def test_contact_sheet_source_over_keeps_observation_background_opaque(tmp_path, alpha, white_observe):
    driver = driver_module()
    src = tmp_path / 'edge.png'
    Image.new('RGBA', (1, 1), (255, 255, 255, alpha)).save(src)
    before = src.read_bytes()
    dest = tmp_path / 'sheet.png'
    driver.write_contact_sheet([('edge', src, src, (1, 1), (1, 1))], dest, white_observe=white_observe)
    background = driver.WHITE_OBSERVE if white_observe else driver.SHEET_BG
    expected = Image.alpha_composite(Image.new('RGBA', (1, 1), background),
                                     Image.new('RGBA', (1, 1), (255, 255, 255, alpha))).getpixel((0, 0))
    with Image.open(dest) as sheet:
        for x in [239, 719]:
            assert sheet.getpixel((x, 315)) == expected
        assert sheet.getchannel('A').getextrema() == (255, 255)
    assert src.read_bytes() == before


def test_declaration_is_closed_enum_and_avoids_customer_content():
    payload = json.loads(DECLARATION_PATH.read_text(encoding="utf-8"))
    assert payload["schema"] == "beian-rfe02-experiment/1"
    assert payload["candidate"] == "normalized-rig-v1"
    assert payload["variants"] == ["control", "normalized-rig-v1"]
    assert payload["suites"]["smoke"] == ["rf00-wide-carton"]
    assert "rf00-alpha-edge" not in payload["suites"]["matrix"]
    assert payload["product_default_semantics"] == "control"
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    fixture_ids = {item["id"] for item in manifest["fixtures"]}
    for fixture_id in payload["suites"]["matrix"]:
        assert fixture_id in fixture_ids
    for path in (DECLARATION_PATH, WRAPPER_PATH, DRIVER_PATH):
        text = path.read_text(encoding="utf-8")
        for token in FORBIDDEN_CONTENT:
            assert token not in text


@pytest.mark.parametrize('outcome', ['complete', 'incomplete', 'insufficient', 'error',
                                     'input_drift', 'texture_drift', 'input_missing',
                                     'output_missing', 'output_corrupt', 'output_hash_mismatch'])
def test_driver_round_writes_bound_report_and_stops_at_first_failure(tmp_path, monkeypatch, outcome):
    from types import SimpleNamespace

    driver = driver_module()
    wrap = driver.wrapper_module()
    root = tmp_path / 'isolated-round'
    root.mkdir()
    monkeypatch.setattr(driver, 'create_experiment_root', lambda: root)
    spec = {'id': 'rf00-wide-carton', 'dimensions_mm': WIDE_DIMS, 'artwork': {}}

    def materialize(_spec, dest):
        dest.mkdir()
        for name in ('source.ai', 'source.ai.structure.json', 'render-profile.json', 'artwork.pdf'):
            (dest / name).write_bytes(('synthetic ' + name).encode())
        return {'input_sha256': driver.sha256_file(dest / 'source.ai'),
                'artwork_sha256': driver.sha256_file(dest / 'artwork.pdf'),
                'artwork_pdf': str(dest / 'artwork.pdf')}

    evaluator = SimpleNamespace(
        resolve_blender_executable=lambda _explicit: Path('/synthetic/blender'),
        load_fixture_manifest=lambda: {}, fixture_by_id=lambda *_args: spec,
        materialize_fixture=materialize,
    )
    pipeline = _PipelineBox(lambda *_a, **_k: pytest.fail('no real process allowed'))
    calls = []

    def preflight(_product, dest, *_args):
        assets = {}
        for face in ('front', 'right', 'back', 'left', 'top', 'bottom'):
            path = dest / ('panel_' + face + '.png')
            write_still(path)
            assets[face] = str(path)
        return {'project_dir': str(dest), 'outputs': _job_outputs(dest), 'assets': assets}

    def render(job, _executable):
        envelope = json.loads(Path(os.environ[driver.ENV_JOB]).read_text())
        variant = envelope['variant']
        calls.append(variant)
        assert pipeline.BLENDER_SCRIPT == driver.WRAPPER_PATH
        assert driver.sha256_file(Path(envelope['declaration_path'])) == envelope['declaration_sha256']
        if outcome == 'error':
            raise RuntimeError('synthetic render failure')
        if outcome == 'input_drift':
            Path(job['project_dir'], 'source.ai').write_bytes(b'changed source')
        elif outcome == 'texture_drift':
            Image.new('RGBA', (16, 16), (99, 24, 36, 255)).save(job['assets']['front'])
        elif outcome == 'input_missing':
            Path(job['project_dir'], 'artwork.pdf').unlink()
        params = wrap.candidate_light_params(WIDE_DIMS, control_light_dicts())
        passes = []
        for key in REQUIRED_STILLS:
            digest = write_still(Path(job['outputs'][key]))
            receipt = complete_pass(key, digest, variant)
            receipt.update(variant=variant, declaration_sha256=envelope['declaration_sha256'])
            if variant != 'control':
                receipt['lights'] = [wrap.snapshot_light_state(FakeLight(item)) for item in params]
            passes.append(receipt)
        output = Path(job['outputs']['front_right'])
        if outcome == 'output_missing':
            output.unlink()
        elif outcome == 'output_corrupt':
            output.write_bytes(b'not a PNG')
            passes[0]['output_sha256'] = driver.sha256_file(output)
        elif outcome == 'output_hash_mismatch':
            Image.new('RGBA', (16, 16), (1, 2, 3, 255)).save(output)
        Path(job['project_dir'], wrap.JOB_RECEIPT_NAME).write_text(json.dumps({
            'passes': passes, 'complete': outcome not in {'incomplete', 'insufficient'},
            'evidence_insufficient': outcome == 'insufficient',
        }))
        return job

    pipeline.preflight_product = preflight
    pipeline.run_blender_job = render
    before_env = os.environ.get(driver.ENV_JOB)
    report = driver.run_experiment(suite='smoke', render=True, pipeline=pipeline, eval_mod=evaluator)
    assert json.loads((root / 'report.json').read_text()) == report
    assert pipeline.BLENDER_SCRIPT == Path('/original/render_job.py')
    assert os.environ.get(driver.ENV_JOB) == before_env
    assert report['quality_improvement'] == 'not_assessed'
    assert report['improvement_passed'] is False
    assert report['identity_verified_after_run'] is True
    if outcome == 'complete':
        assert calls == ['control', 'normalized-rig-v1']
        assert report['ok'] and report['complete'] and report['pairwise'][0]['ok']
        assert report['contact_sheet']['status'] == 'measured'
        assert report['white_observation_sheet']['status'] == 'measured'
        for job in report['jobs']:
            assert job['input_identity_before'] == job['input_identity_after']
            assert set(job['input_identity_before']) == {
                'source_ai', 'structure_sidecar', 'template', 'artwork_pdf', 'assets',
            }
            assert set(job['input_identity_before']['assets']) == {
                'front', 'right', 'back', 'left', 'top', 'bottom',
            }
            assert set(job['originals']) == set(REQUIRED_STILLS)
            for key, path in job['originals'].items():
                assert Path(path).read_bytes() == Path(job['outputs'][key]).read_bytes()
                actual = job['output_evidence'][key]
                assert actual['sha256'] == driver.sha256_file(Path(path))
                assert actual['pixel_sha256'] == driver.pixel_sha256(Path(path))
                assert actual['size_px'] == [16, 16]
    else:
        assert calls == ['control']
        assert not report['ok'] and not report['complete']
        assert report['pairwise'] == []
        assert report['failure_reason'] == {
            'incomplete': 'job_incomplete', 'insufficient': 'evidence_insufficient',
            'error': 'blender_render_failed',
            'input_drift': 'input_changed_during_job', 'texture_drift': 'input_changed_during_job',
            'input_missing': 'input_evidence_missing',
            'output_missing': 'output_evidence_invalid', 'output_corrupt': 'output_evidence_invalid',
            'output_hash_mismatch': 'output_evidence_invalid',
        }[outcome]


@pytest.mark.parametrize('outcome', ['complete', 'missing_file', 'error'])
def test_wrapper_main_restores_hooks_and_persists_failure_evidence(tmp_path, monkeypatch, outcome):
    from types import SimpleNamespace

    wrap = wrap_module()
    declaration = tmp_path / 'declaration.json'
    declaration.write_text('{}')
    envelope = tmp_path / 'envelope.json'
    envelope.write_text(json.dumps({
        'schema': wrap.ENVELOPE_SCHEMA, 'variant': 'control',
        'declaration_path': str(declaration), 'declaration_sha256': wrap.sha256_file(declaration),
    }))
    monkeypatch.setenv(wrap.ENV_JOB, str(envelope))
    outputs = _job_outputs(tmp_path)
    job = {'project_dir': str(tmp_path), 'execution_nonce': 'new-run',
           'outputs': outputs, 'assets': {}, 'dimensions_mm': WIDE_DIMS}
    texture = tmp_path / 'texture.png'
    write_still(texture)
    job['assets']['front'] = str(texture)
    snapshot = tmp_path / 'job.json'
    snapshot.write_text(json.dumps(job))
    scene = FakeScene()
    material = SimpleNamespace(name='paper', node_tree=SimpleNamespace(nodes=[FakeNode(
        'BSDF_PRINCIPLED', {'Roughness': FakeInput(0.52), 'Base Color': FakeInput((0.7, 0.7, 0.7, 1.0))},
    )]))
    scene.objects[1].data.materials = [material]
    renderer = SimpleNamespace(job_path_from_argv=lambda: snapshot, look_at=lambda *_a: None)
    original_add = lambda _job: scene.camera

    def original_still(_scene, path):
        if outcome == 'error':
            raise RuntimeError('renderer failed')
        if outcome != 'missing_file':
            write_still(Path(path))

    def original_main():
        renderer.add_studio(job)
        for key in REQUIRED_STILLS:
            renderer.render_still(scene, outputs[key])
        (tmp_path / 'blender_result.json').write_text(json.dumps({'execution_nonce': 'new-run'}))

    renderer.add_studio, renderer.render_still, renderer.main = original_add, original_still, original_main
    monkeypatch.setattr(wrap, 'load_product_renderer', lambda: renderer)
    monkeypatch.setitem(sys.modules, 'bpy', SimpleNamespace(data=SimpleNamespace(objects=fake_lights())))
    if outcome == 'complete':
        wrap.run_experimental_main()
    elif outcome == 'missing_file':
        with pytest.raises(SystemExit, match='evidence incomplete'):
            wrap.run_experimental_main()
    else:
        with pytest.raises(RuntimeError, match='renderer failed'):
            wrap.run_experimental_main()
    assert renderer.add_studio is original_add
    assert renderer.render_still is original_still
    receipt = json.loads((tmp_path / wrap.JOB_RECEIPT_NAME).read_text())
    pass_receipt = json.loads((tmp_path / wrap.PASS_RECEIPT_NAME).read_text())
    assert receipt['complete'] is (outcome == 'complete')
    assert receipt['main_finished'] is (outcome != 'error')
    assert receipt['passes'] == pass_receipt['passes']
    assert receipt['add_studio_calls'] == 1
    assert len(receipt['passes']) == (1 if outcome == 'error' else 6)
    assert receipt['quality_improvement'] == 'not_assessed'


def test_contact_sheet_refuses_overwrite_and_removes_failed_atomic_temp(tmp_path, monkeypatch):
    driver = driver_module()
    dest = tmp_path / 'sheet.png'
    dest.write_bytes(b'preserve-existing')
    with pytest.raises(driver.wrapper_module().ExperimentError, match='must be new'):
        driver.write_contact_sheet([], dest)
    assert dest.read_bytes() == b'preserve-existing'
    src = tmp_path / 'source.png'
    write_still(src)

    def fail_replace(*_args):
        raise OSError('disk failure')

    monkeypatch.setattr(driver.os, 'replace', fail_replace)
    with pytest.raises(OSError, match='disk failure'):
        driver.write_contact_sheet([('sample', src, src, (16, 16), (16, 16))], tmp_path / 'new.png')
    assert not (tmp_path / 'new.png').exists()
    assert list(tmp_path.glob('.rfe02-contact.*')) == []
