from __future__ import annotations

from pathlib import Path
import importlib.util

PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
EXPORTER = PACKAGING / "illustrator" / "export_structure.jsx"


def load_factory_layers():
    spec = importlib.util.spec_from_file_location(
        "packaging_factory_layers",
        PACKAGING / "structure_v2" / "factory_layers.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_unique_factory_knife_and_print_fallback():
    factory = load_factory_layers()
    assert factory.unique_factory_knife_layer_name(["印刷", "刀版", "标注"]) == "刀版"
    assert factory.unique_factory_knife_layer_name(["刀线", "表"]) == "刀线"
    assert factory.unique_factory_knife_layer_name(["刀版", "刀线"]) is None
    assert factory.unique_factory_knife_layer_name(["刀版", "刀版"]) is None
    assert factory.unique_print_fallback_layer_name(["刀线", "图层 1"]) == "图层 1"
    assert factory.unique_print_fallback_layer_name(["印刷", "刀版", "表"]) is None
    assert factory.unique_print_fallback_layer_name(["图层 1", "图层 7"]) is None


def test_flattened_and_category_holds_are_unsupported_not_review():
    factory = load_factory_layers()
    assert factory.factory_input_hold(Path("26E20A.ai"), ["图层 1"], {}) == (
        "structure_flattened_artwork",
        "当前不支持（拼合稿）。请用未拼合、仍有印刷/刀版分层的源稿重新打样。",
    )
    assert factory.factory_input_hold(
        Path("26G30A-膜袋.ai"),
        ["印刷", "刀版"],
        {"display_name": "膜袋"},
    ) is None
    assert factory.pouch_marker_hint(Path("26G30A-膜袋.ai"), ["印刷", "刀版"], {"display_name": "膜袋"}) is True
    assert factory.pouch_marker_hint(Path("26H11A-面膜.ai"), ["印刷", "刀版"], {"display_name": "面膜"}) is False
    assert factory.pouch_marker_hint(Path("26H24A-7袋装花盒.ai"), ["印刷", "刀线"], {}) is False
    code, message = factory.factory_input_hold(Path("26E20A-内包.ai"), ["印刷", "刀版"], {})
    assert code == "structure_category_unsupported"
    assert "内包" in message
    assert factory.factory_input_hold(Path("26H24A-7袋装花盒.ai"), ["印刷", "刀线"], {}) is None
    assert factory.factory_input_hold(Path("flower.ai"), ["印刷", "刀版", "标注"], {}) is None


def test_print_failure_lists_actual_layer_names():
    factory = load_factory_layers()
    message = factory.print_layer_failure_message(["刀线", "图层 1"])
    assert "刀线" in message
    assert "图层 1" in message
    assert len(message) <= 80


def test_jsx_keeps_the_same_factory_layer_names_as_python():
    factory = load_factory_layers()
    source = EXPORTER.read_text(encoding="utf-8")
    for name in factory.FACTORY_KNIFE_LAYER_NAMES:
        assert f'"{name}"' in source
    for marker in factory.PROCESS_PLATE_MARKERS:
        assert f'"{marker}"' in source
    assert "function uniqueFactoryKnifeLayerName" in source
    assert "function uniquePrintFallbackLayerName" in source
    assert 'config.proposal_layers = [defaultKnife]' in source
