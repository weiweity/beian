"""Studio geometry and resource contracts without importing or launching Blender."""
import ast
import importlib.util
import math
from pathlib import Path
from types import SimpleNamespace

import pytest


def apply_contract(**dependencies):
    source = Path(__file__).resolve().parents[4] / 'workers/packaging/blender/render_job.py'
    tree = ast.parse(source.read_text())
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'apply_studio_contract')
    namespace = dict(dependencies)
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
    return namespace['apply_studio_contract']


def test_legacy_scene_does_not_require_or_mutate_shadow_pool():
    apply_contract()(SimpleNamespace(), {'render': {}}, ())
    eevee = SimpleNamespace(shadow_pool_size='512')
    apply_contract()(SimpleNamespace(eevee=eevee), {'render': {}}, ())
    assert eevee.shadow_pool_size == '512'


@pytest.mark.parametrize('scene', [SimpleNamespace(), SimpleNamespace(eevee=SimpleNamespace())])
def test_missing_shadow_pool_fails_closed(scene):
    with pytest.raises(RuntimeError, match='render_resource_unsupported'):
        apply_contract()(scene, {'render': {'shadow_pool_size_mb': 1024}}, ())


def test_shadow_pool_applied_and_read_back():
    eevee = SimpleNamespace(shadow_pool_size='512')
    apply_contract()(SimpleNamespace(eevee=eevee), {'render': {'shadow_pool_size_mb': 1024}}, ())
    assert eevee.shadow_pool_size == '1024'


@pytest.mark.parametrize('reject', [False, True])
def test_shadow_pool_rejection_or_silent_noop_fails_closed(reject):
    class Eevee:
        @property
        def shadow_pool_size(self):
            return '512'

        @shadow_pool_size.setter
        def shadow_pool_size(self, value):
            if reject:
                raise ValueError('unsupported enum')

    with pytest.raises(RuntimeError, match='render_resource_unsupported'):
        apply_contract()(SimpleNamespace(eevee=Eevee()), {'render': {'shadow_pool_size_mb': 1024}}, ())


class VectorStub:
    """Only the vector arithmetic used by the isolated studio function."""

    def __init__(self, values):
        self.x, self.y, self.z = values

    def __iter__(self):
        return iter((self.x, self.y, self.z))

    def __add__(self, other):
        return VectorStub(a + b for a, b in zip(self, other))

    def __sub__(self, other):
        return VectorStub(a - b for a, b in zip(self, other))

    def __rmul__(self, scalar):
        return VectorStub(scalar * value for value in self)

    @property
    def length(self):
        return math.sqrt(sum(value * value for value in self))


def studio_lights(fill_shape='DISK'):
    return tuple(
        SimpleNamespace(location=VectorStub(location), data=SimpleNamespace(
            shape=shape, size=size, size_y=size_y, energy=energy,
        ))
        for location, shape, size, size_y, energy in (
            ((-135, -190, 275), 'RECTANGLE', 120, 150, 420000),
            ((155, -120, 175), fill_shape, 110, 70, 248000),
            ((-90, 210, 280), 'RECTANGLE', 70, 1, 288000),
        )
    )


@pytest.mark.parametrize('dimensions,scale', [
    ({'width': 90, 'depth': 40, 'height': 60}, 0.5),
    ({'width': 80, 'depth': 180, 'height': 100}, 1),
    ({'width': 160, 'depth': 120, 'height': 360}, 2),
])
@pytest.mark.parametrize('fill_shape', ['DISK', 'ELLIPSE'])
def test_f_studio_preserves_light_geometry_and_irradiance(dimensions, scale, fill_shape):
    lights = studio_lights(fill_shape)
    initial = [(tuple(light.location), light.data.size, light.data.size_y, light.data.energy)
               for light in lights]
    aim_calls = []
    apply = apply_contract(Vector=VectorStub, math=math,
                           look_at=lambda light, target: aim_calls.append((light, tuple(target))))
    apply(SimpleNamespace(eevee=SimpleNamespace(shadow_pool_size='512')), {
        'dimensions_mm': dimensions,
        'render': {'studio_profile': 'normalized-three-area-f-v1',
                   'shadow_pool_size_mb': 1024, 'rig_reference_mm': 180,
                   'fill_energy_multiplier': 0.35, 'key_elevation_delta_deg': -15},
    }, lights)

    center = (0, 0, dimensions['height'] / 2)
    for index, (light, (location, size, size_y, energy)) in enumerate(zip(lights, initial)):
        assert light.data.size == pytest.approx(size * scale)
        assert light.data.size_y == pytest.approx(size_y * (scale if light.data.shape in {'RECTANGLE', 'ELLIPSE'} else 1))
        assert light.data.energy == pytest.approx(energy * scale ** 2 * (0.35 if index == 1 else 1))
        if index:
            assert tuple(light.location) == pytest.approx((
                location[0] * scale, location[1] * scale,
                center[2] + (location[2] - 90) * scale,
            ))

    # Key rotation must preserve its orbit and azimuth while lowering elevation.
    key_offset = lights[0].location - VectorStub(center)
    original_offset = VectorStub(initial[0][0]) - VectorStub((0, 0, 90))
    assert key_offset.length == pytest.approx(original_offset.length * scale)
    assert math.atan2(key_offset.y, key_offset.x) == pytest.approx(math.atan2(original_offset.y, original_offset.x))
    assert math.degrees(math.asin(key_offset.z / key_offset.length)) == pytest.approx(
        math.degrees(math.asin(original_offset.z / original_offset.length)) - 15)
    assert len(aim_calls) == 4
    assert all(target == center for _, target in aim_calls)
    assert [id(light) for light, _ in aim_calls] == [id(light) for light in lights] + [id(lights[0])]


def test_legacy_studio_keeps_existing_light_rig():
    lights = studio_lights()
    initial = [(tuple(light.location), vars(light.data).copy()) for light in lights]
    apply_contract()(SimpleNamespace(), {'render': {}}, lights)
    assert [(tuple(light.location), vars(light.data)) for light in lights] == initial


@pytest.mark.parametrize('key,value', [
    ('rig_reference_mm', 180), ('fill_energy_multiplier', 0.35),
    ('key_elevation_delta_deg', -15),
])
def test_legacy_studio_cannot_accept_f_parameters(key, value):
    source = Path(__file__).resolve().parents[4] / 'workers/packaging/render_contract.py'
    spec = importlib.util.spec_from_file_location('studio_contract_validation', source)
    contract = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(contract)
    studio = contract.load_profile_registry()['profiles']['compat-legacy-v0']['studio'].copy()
    studio[key] = value
    with pytest.raises(contract.RenderContractError, match='旧灯光不得携带 F 参数'):
        contract._normalize_studio(studio, 'studio')
