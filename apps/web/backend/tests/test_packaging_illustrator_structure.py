from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
import subprocess

import pytest


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
WORKER = PACKAGING / "illustrator" / "illustrator_worker.py"
PIPELINE = PACKAGING / "pipeline.py"
EXPORTER = PACKAGING / "illustrator" / "export_structure.jsx"
CURVE_HELPER = PACKAGING / "illustrator" / "curve_flatten.js"
WINDOWS_RUNNER = PACKAGING / "illustrator" / "run_export.vbs"
AGENT_CLIENT = PACKAGING / "illustrator" / "illustrator_agent.py"
AGENT_SCRIPT = PACKAGING.parents[1] / "scripts" / "windows" / "illustrator-agent.ps1"
AGENT_INSTALLER = PACKAGING.parents[1] / "scripts" / "windows" / "install-illustrator-agent.ps1"
AGENT_SMOKE = PACKAGING.parents[1] / "scripts" / "windows" / "illustrator-jsx-smoke.ps1"
SERVER_AGENT = PACKAGING.parents[1] / "apps" / "web" / "server" / "src" / "illustratorAgent.ts"


def load_worker():
    spec = importlib.util.spec_from_file_location("packaging_illustrator_worker_v2", WORKER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_pipeline():
    spec = importlib.util.spec_from_file_location("packaging_pipeline_error_contract", PIPELINE)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_agent_client():
    spec = importlib.util.spec_from_file_location("packaging_illustrator_agent_client", AGENT_CLIENT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_structure_export_is_opt_in_and_legacy_worker_is_unchanged(tmp_path: Path):
    worker = load_worker()
    assert worker.select_jsx({}).name == "export_ai.jsx"
    assert worker.select_jsx({"structure_json": "structure.json"}).name == "export_structure.jsx"
    config_path = tmp_path / "job.json"
    runtime = worker.bind_runtime_jsx(config_path, {"structure_json": "structure.json"})
    source = runtime.read_text(encoding="utf-8")
    assert runtime.parent == tmp_path
    assert '#include "curve_flatten.js"' not in source
    assert source.count("function flattenCubicSegment") == 1
    assert "flattenCubicSegment(" in source


def test_mac_worker_reports_runtime_jsx_binding_failure_without_traceback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    worker = load_worker()
    config_path = tmp_path / "illustrator-input.json"
    config_path.write_text(
        json.dumps(
            {
                "application": str(tmp_path / "Illustrator.app"),
                "source_ai": str(tmp_path / "source.ai"),
                "full_pdf": str(tmp_path / "full.pdf"),
                "print_pdf": str(tmp_path / "print.pdf"),
                "structure_json": str(tmp_path / "structure.json"),
                "result_json": str(tmp_path / "result.json"),
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(worker.sys, "platform", "darwin")
    monkeypatch.setattr(worker, "warm_up_illustrator", lambda *_args: pytest.fail("Illustrator must not start"))
    monkeypatch.setattr(worker, "open_document_externally", lambda *_args: pytest.fail("source must not open"))
    monkeypatch.setattr(
        worker,
        "bind_runtime_jsx",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("curve helper missing")),
    )
    monkeypatch.setattr(worker.sys, "argv", [str(WORKER), str(config_path)])

    assert worker.main() == 2
    stderr = capsys.readouterr().err
    assert stderr.strip() == "Illustrator exporter setup failed: curve helper missing"
    assert "Traceback" not in stderr


def test_structure_export_hides_structure_objects_and_isolates_declared_print_layers():
    source = EXPORTER.read_text(encoding="utf-8")
    assert "item.hidden = true" in source
    assert "withConfiguredPrintLayers(documentRef, config.print_layers" in source
    assert 'adapter: "illustrator-semantic/1"' in source
    assert 'structure_face_mapping_incomplete' in source


def test_structure_export_temporarily_unlocks_parent_chain_and_restores_it():
    source = EXPORTER.read_text(encoding="utf-8")
    helper_start = source.index("function findLockState")
    helper_end = source.index("var configPath", helper_start)
    helpers = source[helper_start:helper_end]
    program = helpers + r"""
var documentRef = {typename: "Document"};
var layer = {typename: "Layer", locked: true, parent: documentRef};
var group = {typename: "GroupItem", locked: true, parent: layer};
var first = {typename: "PathItem", locked: true, hidden: false, parent: group};
var second = {typename: "PathItem", locked: false, hidden: false, parent: group};
var state = hideSemanticItems([first, second]);
var hiddenState = {
    firstHidden: first.hidden,
    secondHidden: second.hidden,
    firstLocked: first.locked,
    groupLocked: group.locked,
    layerLocked: layer.locked,
    lockCount: state.locks.length
};
restoreSemanticItems(state);
process.stdout.write(JSON.stringify({
    hiddenState: hiddenState,
    restored: {
        firstHidden: first.hidden,
        secondHidden: second.hidden,
        firstLocked: first.locked,
        secondLocked: second.locked,
        groupLocked: group.locked,
        layerLocked: layer.locked
    }
}));
"""
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )

    result = json.loads(completed.stdout)
    assert result["hiddenState"] == {
        "firstHidden": True,
        "secondHidden": True,
        "firstLocked": False,
        "groupLocked": False,
        "layerLocked": False,
        "lockCount": 3,
    }
    assert result["restored"] == {
        "firstHidden": False,
        "secondHidden": False,
        "firstLocked": True,
        "secondLocked": False,
        "groupLocked": True,
        "layerLocked": True,
    }


def test_structure_export_restores_partial_changes_when_hiding_fails():
    source = EXPORTER.read_text(encoding="utf-8")
    helper_start = source.index("function findLockState")
    helper_end = source.index("var configPath", helper_start)
    helpers = source[helper_start:helper_end]
    program = helpers + r"""
var documentRef = {typename: "Document"};
var layer = {typename: "Layer", locked: true, parent: documentRef};
var group = {typename: "GroupItem", locked: true, parent: layer};
var first = {typename: "PathItem", locked: true, hidden: false, parent: group};
var secondHidden = false;
var second = {typename: "PathItem", locked: false, parent: group};
Object.defineProperty(second, "hidden", {
    get: function () { return secondHidden; },
    set: function (value) {
        if (value === true) {
            throw new Error("blocked by Illustrator");
        }
        secondHidden = value;
    }
});
var message = null;
try {
    hideSemanticItems([first, second]);
} catch (error) {
    message = error.message;
}
process.stdout.write(JSON.stringify({
    message: message,
    firstHidden: first.hidden,
    secondHidden: second.hidden,
    firstLocked: first.locked,
    secondLocked: second.locked,
    groupLocked: group.locked,
    layerLocked: layer.locked
}));
"""
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(completed.stdout) == {
        "message": "Cannot hide semantic object path:1 blocked by Illustrator",
        "firstHidden": False,
        "secondHidden": False,
        "firstLocked": True,
        "secondLocked": False,
        "groupLocked": True,
        "layerLocked": True,
    }


def test_structure_export_restores_original_state_when_artwork_save_fails():
    source = EXPORTER.read_text(encoding="utf-8")
    helper_start = source.index("function findLockState")
    helper_end = source.index("var configPath", helper_start)
    helpers = source[helper_start:helper_end]
    program = helpers + r"""
var documentRef = {typename: "Document"};
var layer = {typename: "Layer", locked: true, parent: documentRef};
var visible = {typename: "PathItem", locked: true, hidden: false, parent: layer};
var alreadyHidden = {typename: "PathItem", locked: false, hidden: true, parent: layer};
var observed = null;
var message = null;
try {
    withHiddenSemanticItems([visible, alreadyHidden], function () {
        observed = {
            visibleHidden: visible.hidden,
            alreadyHidden: alreadyHidden.hidden,
            layerLocked: layer.locked
        };
        throw new Error("artwork save failed");
    });
} catch (error) {
    message = error.message;
}
process.stdout.write(JSON.stringify({
    message: message,
    observed: observed,
    restored: {
        visibleHidden: visible.hidden,
        alreadyHidden: alreadyHidden.hidden,
        visibleLocked: visible.locked,
        alreadyHiddenLocked: alreadyHidden.locked,
        layerLocked: layer.locked
    }
}));
"""
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(completed.stdout) == {
        "message": "artwork save failed",
        "observed": {
            "visibleHidden": True,
            "alreadyHidden": True,
            "layerLocked": False,
        },
        "restored": {
            "visibleHidden": False,
            "alreadyHidden": True,
            "visibleLocked": True,
            "alreadyHiddenLocked": False,
            "layerLocked": True,
        },
    }


def test_structure_export_restores_declared_print_layer_visibility_when_save_fails():
    source = EXPORTER.read_text(encoding="utf-8")
    helper_start = source.index("function findLockState")
    helper_end = source.index("var configPath", helper_start)
    helpers = source[helper_start:helper_end]
    program = helpers + r"""
var printLayer = {name: "印刷", visible: false};
var codeLayer = {name: "码", visible: true};
var annotationLayer = {name: "标注", visible: true};
var documentRef = {layers: [printLayer, codeLayer, annotationLayer]};
var observed = null;
var message = null;
try {
    withConfiguredPrintLayers(documentRef, ["印刷"], function () {
        observed = {
            printLayer: printLayer.visible,
            codeLayer: codeLayer.visible,
            annotationLayer: annotationLayer.visible
        };
        throw new Error("artwork save failed");
    });
} catch (error) {
    message = error.message;
}
process.stdout.write(JSON.stringify({
    message: message,
    observed: observed,
    restored: {
        printLayer: printLayer.visible,
        codeLayer: codeLayer.visible,
        annotationLayer: annotationLayer.visible
    }
}));
"""
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(completed.stdout) == {
        "message": "artwork save failed",
        "observed": {
            "printLayer": True,
            "codeLayer": False,
            "annotationLayer": False,
        },
        "restored": {
            "printLayer": False,
            "codeLayer": True,
            "annotationLayer": True,
        },
    }


def test_print_layer_isolation_fails_closed_and_restores_every_observed_state():
    source = EXPORTER.read_text(encoding="utf-8")
    helper_start = source.index("function findLockState")
    helper_end = source.index("var configPath", helper_start)
    helpers = source[helper_start:helper_end]
    program = helpers + r"""
function errorOf(callback) {
    try {
        callback();
        return null;
    } catch (error) {
        return error.message;
    }
}

var normalized = normalizedPrintLayerNames(["印刷", "", "印刷", "辅助印刷"]);
var invalidConfigError = errorOf(function () {
    normalizedPrintLayerNames("印刷");
});
var emptyConfigError = errorOf(function () {
    normalizedPrintLayerNames([]);
});

var successPrint = {name: "印刷", visible: false};
var successCode = {name: "码", visible: true};
var successObserved = null;
var successError = errorOf(function () {
    withConfiguredPrintLayers(
        {layers: [successPrint, successCode]},
        ["印刷"],
        function () {
            successObserved = [successPrint.visible, successCode.visible];
        }
    );
});

var missingPrint = {name: "印刷", visible: false};
var missingCode = {name: "码", visible: true};
var missingError = errorOf(function () {
    withConfiguredPrintLayers(
        {layers: [missingPrint, missingCode]},
        ["不存在"],
        function () {}
    );
});

var setPrint = {name: "印刷", visible: false};
var codeVisible = true;
var blockedCode = {name: "码"};
Object.defineProperty(blockedCode, "visible", {
    get: function () { return codeVisible; },
    set: function (value) {
        if (value === false) {
            throw new Error("blocked hide");
        }
        codeVisible = value;
    }
});
var settingError = errorOf(function () {
    withConfiguredPrintLayers(
        {layers: [setPrint, blockedCode]},
        ["印刷"],
        function () {}
    );
});

function stickyLayer() {
    var visible = false;
    var layer = {name: "印刷"};
    Object.defineProperty(layer, "visible", {
        get: function () { return visible; },
        set: function (value) {
            if (value === false) {
                throw new Error("cannot restore");
            }
            visible = value;
        }
    });
    return layer;
}
var restoreOnly = stickyLayer();
var restoreOnlyError = errorOf(function () {
    withConfiguredPrintLayers(
        {layers: [restoreOnly]},
        ["印刷"],
        function () {}
    );
});
var restoreAndSave = stickyLayer();
var doubleError = errorOf(function () {
    withConfiguredPrintLayers(
        {layers: [restoreAndSave]},
        ["印刷"],
        function () { throw new Error("save failed"); }
    );
});

process.stdout.write(JSON.stringify({
    normalized: normalized,
    invalidConfigError: invalidConfigError,
    emptyConfigError: emptyConfigError,
    successError: successError,
    successObserved: successObserved,
    successRestored: [successPrint.visible, successCode.visible],
    missingError: missingError,
    missingRestored: [missingPrint.visible, missingCode.visible],
    settingError: settingError,
    settingRestored: [setPrint.visible, blockedCode.visible],
    restoreOnlyError: restoreOnlyError,
    doubleError: doubleError
}));
"""
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(completed.stdout) == {
        "normalized": ["印刷", "辅助印刷"],
        "invalidConfigError": "print_layers must be an array",
        "emptyConfigError": "print_layers must name at least one explicit artwork layer",
        "successError": None,
        "successObserved": [True, False],
        "successRestored": [False, True],
        "missingError": "Configured artwork layer not found: 不存在",
        "missingRestored": [False, True],
        "settingError": "blocked hide",
        "settingRestored": [False, True],
        "restoreOnlyError": "Cannot fully restore artwork layers: 印刷:cannot restore",
        "doubleError": (
            "save failed | Cannot fully restore artwork layers: 印刷:cannot restore"
        ),
    }


def test_structure_export_skips_unsupported_host_locks_and_uses_layer_parent_fallback():
    source = EXPORTER.read_text(encoding="utf-8")
    helper_start = source.index("function findLockState")
    helper_end = source.index("var configPath", helper_start)
    helpers = source[helper_start:helper_end]
    program = helpers + r"""
var documentRef = {typename: "Document"};
var layer = {typename: "Layer", locked: true, parent: documentRef};
var clip = {typename: "GroupItem", parent: layer};
Object.defineProperty(clip, "locked", {
    get: function () { throw new Error("clip lock is not exposed"); },
    set: function () { throw new Error("clip lock is not exposed"); }
});
var compound = {typename: "CompoundPathItem", locked: true, hidden: false, parent: clip};
var symbol = {typename: "SymbolItem", locked: true, hidden: false, layer: layer};
Object.defineProperty(symbol, "parent", {
    get: function () { throw new Error("symbol parent proxy failed"); }
});
var compoundState = hideSemanticItems([compound]);
var compoundObserved = {
    hidden: compound.hidden,
    locked: compound.locked,
    layerLocked: layer.locked,
    issues: compoundState.issues
};
restoreSemanticItems(compoundState);
var symbolState = hideSemanticItems([symbol]);
var symbolObserved = {
    hidden: symbol.hidden,
    locked: symbol.locked,
    layerLocked: layer.locked,
    issues: symbolState.issues
};
restoreSemanticItems(symbolState);
process.stdout.write(JSON.stringify({
    compoundObserved: compoundObserved,
    symbolObserved: symbolObserved,
    restored: {
        compoundHidden: compound.hidden,
        compoundLocked: compound.locked,
        symbolHidden: symbol.hidden,
        symbolLocked: symbol.locked,
        layerLocked: layer.locked
    }
}));
"""
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )

    result = json.loads(completed.stdout)
    assert result["compoundObserved"] == {
        "hidden": True,
        "locked": False,
        "layerLocked": False,
        "issues": ["ancestor_lock_unreadable:GroupItem"],
    }
    assert result["symbolObserved"] == {
        "hidden": True,
        "locked": False,
        "layerLocked": False,
        "issues": ["ancestor_parent_via_layer:SymbolItem"],
    }
    assert result["restored"] == {
        "compoundHidden": False,
        "compoundLocked": True,
        "symbolHidden": False,
        "symbolLocked": True,
        "layerLocked": True,
    }


def test_structure_export_attempts_every_rollback_before_reporting_failure():
    source = EXPORTER.read_text(encoding="utf-8")
    helper_start = source.index("function findLockState")
    helper_end = source.index("var configPath", helper_start)
    helpers = source[helper_start:helper_end]
    program = helpers + r"""
var firstValue = false;
var first = {typename: "PathItem"};
Object.defineProperty(first, "locked", {
    get: function () { return firstValue; },
    set: function (value) {
        if (value === true) { throw new Error("first restore failed"); }
        firstValue = value;
    }
});
var second = {typename: "PathItem", locked: false};
var state = {
    items: [],
    locks: [
        {target: second, locked: true, typeName: "PathItem"},
        {target: first, locked: true, typeName: "PathItem"}
    ],
    issues: []
};
var message = null;
try {
    restoreSemanticItems(state);
} catch (error) {
    message = error.message;
}
process.stdout.write(JSON.stringify({message: message, secondLocked: second.locked}));
"""
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )

    result = json.loads(completed.stdout)
    assert result == {
        "message": "Cannot fully restore semantic objects: locked:PathItem:first restore failed",
        "secondLocked": True,
    }


def test_structure_export_records_lock_before_a_host_setter_mutates_then_throws():
    source = EXPORTER.read_text(encoding="utf-8")
    helper_start = source.index("function findLockState")
    helper_end = source.index("var configPath", helper_start)
    helpers = source[helper_start:helper_end]
    program = helpers + r"""
var lockedValue = true;
var item = {typename: "PathItem", hidden: false};
Object.defineProperty(item, "locked", {
    get: function () { return lockedValue; },
    set: function (value) {
        lockedValue = value;
        throw new Error("Illustrator proxy setter threw after mutation");
    }
});
var state = hideSemanticItems([item]);
var observed = {
    hidden: item.hidden,
    locked: item.locked,
    lockCount: state.locks.length
};
restoreSemanticItems(state);
process.stdout.write(JSON.stringify({
    observed: observed,
    restoredHidden: item.hidden,
    restoredLocked: item.locked
}));
"""
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(completed.stdout) == {
        "observed": {"hidden": True, "locked": False, "lockCount": 1},
        "restoredHidden": False,
        "restoredLocked": True,
    }


def test_structure_export_flattens_curves_with_a_bounded_audited_adapter():
    source = EXPORTER.read_text(encoding="utf-8")
    assert '#include "curve_flatten.js"' in source
    assert "flattenCubicSegment(" in source
    assert "structure_curve_requires_adapter" not in source
    assert 'kind: "bezier_flatten"' in source
    assert '"structure_repair_ledger_truncated"' in source
    assert '"structure_curve_complexity_exceeded"' in source
    assert "flattened === null" in source
    assert "flattened.length - 1 > 256" in source
    assert "localEdges.length + flattened.length - 1 > 4096" in source
    assert "structure.edges.length + localEdges.length > 20000" in source
    assert "chosenRecords.length > 5000" in source
    assert "!hasFatalStructureError(structure.validation.errors)" in source
    assert 'coordinate_frame: "artboard-top-left"' in source
    assert 'adapter_version: "1.1.0"' in source


def test_curve_adapter_preserves_endpoints_and_stays_inside_the_declared_tolerance():
    helper = CURVE_HELPER.read_text(encoding="utf-8")
    program = helper + "\nprocess.stdout.write(JSON.stringify(flattenCubicSegment([0,0],[0,100],[100,100],[100,0],0.25,12)));"
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )
    points = json.loads(completed.stdout)

    assert points[0] == [0, 0]
    assert points[-1] == [100, 0]
    assert 2 < len(points) <= 257

    def cubic(t: float) -> tuple[float, float]:
        one = 1.0 - t
        return (
            3 * one * t * t * 100 + t * t * t * 100,
            3 * one * one * t * 100 + 3 * one * t * t * 100,
        )

    def segment_distance(point: tuple[float, float], start: list[float], end: list[float]) -> float:
        dx = end[0] - start[0]
        dy = end[1] - start[1]
        length_squared = dx * dx + dy * dy
        if length_squared == 0:
            return math.hypot(point[0] - start[0], point[1] - start[1])
        ratio = max(0.0, min(1.0, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length_squared))
        nearest = (start[0] + ratio * dx, start[1] + ratio * dy)
        return math.hypot(point[0] - nearest[0], point[1] - nearest[1])

    maximum_error = max(
        min(segment_distance(cubic(index / 1000), points[item], points[item + 1]) for item in range(len(points) - 1))
        for index in range(1001)
    )
    assert maximum_error <= 0.25


def test_curve_adapter_preserves_collinear_handle_reversals_instead_of_collapsing_them():
    helper = CURVE_HELPER.read_text(encoding="utf-8")
    program = helper + "\nprocess.stdout.write(JSON.stringify(flattenCubicSegment([0,0],[100,0],[-100,0],[1,0],0.25,12)));"
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )
    points = json.loads(completed.stdout)

    assert points[0] == [0, 0]
    assert points[-1] == [1, 0]
    assert 2 < len(points) <= 257
    assert min(point[0] for point in points) < -28
    assert max(point[0] for point in points) > 28


def test_curve_adapter_fails_closed_when_the_depth_budget_cannot_meet_tolerance():
    helper = CURVE_HELPER.read_text(encoding="utf-8")
    program = helper + "\nprocess.stdout.write(JSON.stringify(flattenCubicSegment([0,0],[0,100],[100,100],[100,0],0.25,0)));"
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(completed.stdout) is None


def test_explicit_ignore_objects_are_removed_from_artwork_without_becoming_edges():
    source = EXPORTER.read_text(encoding="utf-8")
    semantic_push = source.index("semanticItems.push(record.item)")
    ignore_guard = source.index('if (record.assignment === "ignore")')
    edge_export = source.index("exportSemanticPath(", ignore_guard)
    assert semantic_push < ignore_guard < edge_export


def test_semantics_require_exact_tags_or_explicit_config():
    source = EXPORTER.read_text(encoding="utf-8")
    assert 'var prefix = "packaging:"' in source
    assert 'configuredAssignment(config, "layers"' in source
    assert 'configuredAssignment(config, "spots"' in source
    assert "刀线" not in source
    assert "刀版" not in source


def test_legacy_proposal_layers_only_offer_stroke_only_paths_for_human_confirmation():
    source = EXPORTER.read_text(encoding="utf-8")
    assert "configuredProposalLayer(item, config)" in source
    assert "item.stroked && !item.filled" in source
    assert 'adapter = "illustrator-stroke-proposal/1"' in source
    assert '"structure_proposal_requires_confirmation"' in source
    assert "explicitRecords.length > 0 ? explicitRecords : proposalRecords" in source


def _structure_preview_helpers() -> str:
    source = EXPORTER.read_text(encoding="utf-8")
    preview_start = source.index("function proposalLayerKey")
    preview_end = source.index("function samePoint", preview_start)
    point_start = source.index("function structurePoint")
    point_end = source.index("function exportSemanticPath", point_start)
    return source[point_start:point_end] + source[preview_start:preview_end]


def test_structure_export_collects_source_aligned_bezier_layer_preview():
    program = _structure_preview_helpers() + r"""
var documentRef = {typename: "Document"};
var layer = {typename: "Layer", name: "刀线", parent: documentRef, zOrderPosition: 2};
var item = {
    layer: layer,
    stroked: true,
    filled: false,
    closed: false,
    pathPoints: [
        {anchor: [10, 80], leftDirection: [10, 80], rightDirection: [20, 70]},
        {anchor: [40, 50], leftDirection: [30, 60], rightDirection: [40, 50]}
    ]
};
var candidates = [];
var keys = [];
var budget = {paths: 0, points: 0};
recordProposalLayerCandidate(candidates, keys, item, 0, 100, budget);
process.stdout.write(JSON.stringify({candidate: candidates[0], budget: budget}));
"""
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )

    result = json.loads(completed.stdout)
    assert result["candidate"] == {
        "name": "刀线",
        "stroke_only_path_count": 1,
        "preview_paths": [
            {
                "closed": False,
                "points": [
                    [10, 20, 10, 20, 20, 30],
                    [40, 50, 30, 40, 40, 50],
                ],
            }
        ],
        "preview_truncated": False,
    }
    assert result["budget"] == {"paths": 1, "points": 2}


def test_structure_export_preview_budget_and_invalid_points():
    program = _structure_preview_helpers() + r"""
var documentRef = {typename: "Document"};
var layer = {typename: "Layer", name: "刀线", parent: documentRef, zOrderPosition: 2};
function makeItem(count, mutateFirst) {
    var pathPoints = [];
    for (var index = 0; index < count; index += 1) {
        var anchor = [index, 80];
        pathPoints.push({anchor: anchor, leftDirection: anchor.slice(), rightDirection: anchor.slice()});
    }
    if (mutateFirst) mutateFirst(pathPoints[0]);
    return {layer: layer, stroked: true, filled: false, closed: false, pathPoints: pathPoints};
}
var oversized = [];
var oversizedKeys = [];
var oversizedBudget = {paths: 0, points: 0};
recordProposalLayerCandidate(oversized, oversizedKeys, makeItem(257), 0, 100, oversizedBudget);
var nanCandidate = {preview_paths: [], preview_truncated: false};
var nanBudget = {paths: 0, points: 0};
appendProposalPreview(nanCandidate, makeItem(2, function (point) { point.anchor = [Number.NaN, 80]; }), 0, 100, nanBudget);
var overflowCandidate = {preview_paths: [], preview_truncated: false};
var overflowBudget = {paths: 0, points: 0};
appendProposalPreview(overflowCandidate, makeItem(2, function (point) { point.anchor = [10000001, 80]; }), 0, 100, overflowBudget);
var pathBudgetCandidate = {preview_paths: [], preview_truncated: false};
var pathBudget = {paths: 5000, points: 0};
appendProposalPreview(pathBudgetCandidate, makeItem(2), 0, 100, pathBudget);
var pointBudgetCandidate = {preview_paths: [], preview_truncated: false};
var pointBudget = {paths: 0, points: 19999};
appendProposalPreview(pointBudgetCandidate, makeItem(2), 0, 100, pointBudget);
var layerCap = [];
for (var fill = 0; fill < 512; fill += 1) layerCap.push({closed: false, points: [[0, 0, 0, 0, 0, 0], [1, 0, 1, 0, 1, 0]]});
var layerCapCandidate = {preview_paths: layerCap, preview_truncated: false};
var layerCapBudget = {paths: 512, points: 1024};
appendProposalPreview(layerCapCandidate, makeItem(2), 0, 100, layerCapBudget);
process.stdout.write(JSON.stringify({
    oversized: {paths: oversized[0].preview_paths.length, truncated: oversized[0].preview_truncated, budget: oversizedBudget},
    nan: {paths: nanCandidate.preview_paths.length, truncated: nanCandidate.preview_truncated, budget: nanBudget},
    overflow: {paths: overflowCandidate.preview_paths.length, truncated: overflowCandidate.preview_truncated, budget: overflowBudget},
    pathBudget: {paths: pathBudgetCandidate.preview_paths.length, truncated: pathBudgetCandidate.preview_truncated, budget: pathBudget},
    pointBudget: {paths: pointBudgetCandidate.preview_paths.length, truncated: pointBudgetCandidate.preview_truncated, budget: pointBudget},
    layerCap: {paths: layerCapCandidate.preview_paths.length, truncated: layerCapCandidate.preview_truncated, budget: layerCapBudget}
}));
"""
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )
    result = json.loads(completed.stdout)
    empty = {"paths": 0, "truncated": True}
    assert result["oversized"]["paths"] == 0
    assert result["oversized"]["truncated"] is True
    assert result["oversized"]["budget"] == {"paths": 0, "points": 0}
    assert {key: result["nan"][key] for key in empty} == empty
    assert result["nan"]["budget"] == {"paths": 0, "points": 0}
    assert {key: result["overflow"][key] for key in empty} == empty
    assert result["pathBudget"]["truncated"] is True
    assert result["pathBudget"]["budget"] == {"paths": 5000, "points": 0}
    assert result["pointBudget"]["truncated"] is True
    assert result["pointBudget"]["budget"] == {"paths": 0, "points": 19999}
    assert result["layerCap"]["paths"] == 512
    assert result["layerCap"]["truncated"] is True
    assert result["layerCap"]["budget"] == {"paths": 512, "points": 1024}


def test_unassigned_stroke_only_layers_are_listed_without_becoming_structure():
    source = EXPORTER.read_text(encoding="utf-8")
    helper_start = source.index("function exactAssignment")
    helper_end = source.index("var configPath", helper_start)
    helpers = source[helper_start:helper_end]
    program = helpers + r"""
var candidates = [];
var layerKeys = [];
recordProposalLayerCandidate(candidates, layerKeys, {stroked: true, filled: false, layer: {name: "结构-A", zOrderPosition: 0}});
recordProposalLayerCandidate(candidates, layerKeys, {stroked: true, filled: false, layer: {name: "结构-A", zOrderPosition: 0}});
recordProposalLayerCandidate(candidates, layerKeys, {stroked: true, filled: true, layer: {name: "填色稿", zOrderPosition: 1}});
recordProposalLayerCandidate(candidates, layerKeys, {stroked: false, filled: false, layer: {name: "无描边", zOrderPosition: 2}});
recordProposalLayerCandidate(candidates, layerKeys, {stroked: true, filled: false, layer: {name: "结构-B", zOrderPosition: 3}});
recordProposalLayerCandidate(candidates, layerKeys, {stroked: true, filled: false, layer: {name: "", zOrderPosition: 4}});
process.stdout.write(JSON.stringify(candidates));
"""
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(completed.stdout) == [
        {"name": "结构-A", "stroke_only_path_count": 2},
        {"name": "结构-B", "stroke_only_path_count": 1},
    ]
    assert "proposal_layer_candidates: []" in source
    assert "proposalRecords.push" in source


def test_duplicate_physical_layer_names_are_marked_ambiguous():
    source = EXPORTER.read_text(encoding="utf-8")
    helper_start = source.index("function exactAssignment")
    helper_end = source.index("var configPath", helper_start)
    helpers = source[helper_start:helper_end]
    program = helpers + r"""
var candidates = [];
var layerKeys = [];
recordProposalLayerCandidate(candidates, layerKeys, {stroked: true, filled: false, layer: {name: "结构-A", zOrderPosition: 0}});
recordProposalLayerCandidate(candidates, layerKeys, {stroked: true, filled: false, layer: {name: "结构-A", zOrderPosition: 1}});
process.stdout.write(JSON.stringify(candidates));
"""
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(completed.stdout) == [
        {"name": "结构-A", "stroke_only_path_count": 1, "ambiguous_name": True},
        {"name": "结构-A", "stroke_only_path_count": 1, "ambiguous_name": True},
    ]


def test_unassigned_layer_inventory_is_bounded_and_reports_truncation():
    source = EXPORTER.read_text(encoding="utf-8")
    helper_start = source.index("function exactAssignment")
    helper_end = source.index("var configPath", helper_start)
    helpers = source[helper_start:helper_end]
    program = helpers + r"""
var candidates = [];
var layerKeys = [];
var truncated = false;
for (var index = 0; index < 129; index += 1) {
    if (recordProposalLayerCandidate(candidates, layerKeys, {
        stroked: true,
        filled: false,
        layer: {name: "结构-" + index, zOrderPosition: index}
    })) {
        truncated = true;
    }
}
process.stdout.write(JSON.stringify({candidates: candidates, truncated: truncated}));
"""
    completed = subprocess.run(
        ["node", "-e", program],
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(completed.stdout)
    assert len(payload["candidates"]) == 128
    assert payload["candidates"][0]["name"] == "结构-0"
    assert payload["candidates"][-1]["name"] == "结构-127"
    assert payload["truncated"] is True


def test_explicit_semantics_suppress_inapplicable_layer_candidates():
    source = EXPORTER.read_text(encoding="utf-8")
    suppression = source.index("if (explicitRecords.length > 0)")
    chosen_records = source.index(
        "var chosenRecords = explicitRecords.length > 0 ? explicitRecords : proposalRecords"
    )

    assert suppression < chosen_records
    assert "result.proposal_layer_candidates = [];" in source[suppression:chosen_records]
    assert (
        "result.proposal_layer_candidates_truncated = false;"
        in source[suppression:chosen_records]
    )


def test_proposal_paths_are_cleaned_from_artwork_without_hiding_the_whole_layer():
    source = EXPORTER.read_text(encoding="utf-8")
    assert "chosenRecords" in source
    assert "semanticItems.push(record.item)" in source
    assert "withHiddenSemanticItems(semanticItems" in source


def test_structure_export_passes_explicit_print_layers_to_illustrator(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    pipeline = load_pipeline()
    source = tmp_path / "source.ai"
    source.write_bytes(b"ai")
    illustrator = tmp_path / "Illustrator.app"
    illustrator.mkdir()
    captured: dict[str, object] = {}

    def fake_run(command, capture_output, text):
        config_path = Path(command[2])
        config = json.loads(config_path.read_text(encoding="utf-8"))
        captured.update(config)
        for key in ("full_pdf", "print_pdf", "structure_json"):
            Path(config[key]).write_bytes(b"output")
        Path(config["result_json"]).write_text(
            json.dumps(
                {
                    "success": True,
                    "full_pdf": config["full_pdf"],
                    "print_pdf": config["print_pdf"],
                    "structure_json": config["structure_json"],
                }
            ),
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(command, 0, "ok", "")

    monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
    source_sha256 = pipeline.file_sha256(source)
    result = pipeline.run_illustrator_structure_export(
        source,
        tmp_path / "project",
        {"application": str(illustrator)},
        proposal_layers=["供应商结构候选"],
        print_layers=["印刷"],
        source_sha256=source_sha256,
    )

    assert result["success"] is True
    assert captured["source_sha256"] == source_sha256
    assert captured["proposal_layers"] == ["供应商结构候选"]
    assert captured["print_layers"] == ["印刷"]


@pytest.mark.parametrize("print_layers", [None, [], "印刷"])
def test_structure_export_rejects_missing_or_non_array_print_layers_before_worker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    print_layers,
):
    pipeline = load_pipeline()
    source = tmp_path / "source.ai"
    source.write_bytes(b"ai")
    illustrator = tmp_path / "Illustrator.app"
    illustrator.mkdir()
    monkeypatch.setattr(
        pipeline.subprocess,
        "run",
        lambda *_args, **_kwargs: pytest.fail("invalid print layers must fail before Illustrator"),
    )

    with pytest.raises(pipeline.PipelineError) as caught:
        pipeline.run_illustrator_structure_export(
            source,
            tmp_path / "project",
            {"application": str(illustrator)},
            print_layers=print_layers,
        )

    assert caught.value.as_dict() == {
        "ok": False,
        "code": "packaging_print_layers_missing",
        "error": "渲染配置没有声明印刷图层，无法安全生成贴图",
        "cause": "print_layers must be a non-empty list",
        "fix": "在对应包装模板中声明稿件现有的顶层印刷图层，再重新打样",
    }


def test_structure_export_rejects_a_source_changed_since_preflight(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    pipeline = load_pipeline()
    source = tmp_path / "source.ai"
    source.write_bytes(b"changed-ai")
    illustrator = tmp_path / "Illustrator.app"
    illustrator.mkdir()
    monkeypatch.setattr(
        pipeline.subprocess,
        "run",
        lambda *_args, **_kwargs: pytest.fail("stale source must fail before Illustrator"),
    )

    with pytest.raises(pipeline.PipelineError) as caught:
        pipeline.run_illustrator_structure_export(
            source,
            tmp_path / "project",
            {"application": str(illustrator)},
            print_layers=["印刷"],
            source_sha256="0" * 64,
        )

    assert caught.value.code == "packaging_structure_selection_stale"


def test_v2_preflight_passes_template_print_layers_to_the_illustrator_exporter(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    pipeline = load_pipeline()
    source = tmp_path / "source.ai"
    source.write_bytes(b"native-ai")
    template = tmp_path / "template.json"
    template.write_text(json.dumps({"print_layers": ["印刷"]}), encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_export(*_args, **kwargs):
        captured.update(kwargs)
        export_dir = tmp_path / "export"
        export_dir.mkdir()
        artwork = export_dir / "artwork.pdf"
        structure = export_dir / "structure.json"
        artwork.write_bytes(b"artwork")
        structure.write_text("{}", encoding="utf-8")
        return {"print_pdf": str(artwork), "structure_json": str(structure)}

    class ReachedResolver(RuntimeError):
        pass

    def stop_after_export(*_args, **_kwargs):
        raise ReachedResolver("export contract observed")

    monkeypatch.setattr(pipeline, "run_illustrator_structure_export", fake_export)
    monkeypatch.setattr(pipeline, "resolve_structure", stop_after_export)

    with pytest.raises(ReachedResolver, match="export contract observed"):
        pipeline.preflight_product_v2(
            {
                "code": "PRINT-LAYERS",
                "slug": "print-layers",
                "display_name": "印刷层合同",
                "source_ai": source.name,
                "template": template.name,
            },
            tmp_path,
            tmp_path / "output",
            False,
            {"enabled": True},
        )

    assert captured["print_layers"] == ["印刷"]
    assert captured["source_sha256"] == pipeline.file_sha256(source)


def test_v2_preflight_never_auto_selects_pdf_ocg_layer_names(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    pipeline = load_pipeline()
    source = tmp_path / "source.ai"
    source.write_bytes(b"native-ai")
    template = tmp_path / "template.json"
    template.write_text(json.dumps({"print_layers": ["印刷"]}), encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_export(*_args, **kwargs):
        captured.update(kwargs)
        export_dir = tmp_path / "export"
        export_dir.mkdir()
        artwork = export_dir / "artwork.pdf"
        structure = export_dir / "structure.json"
        artwork.write_bytes(b"artwork")
        structure.write_text("{}", encoding="utf-8")
        return {"print_pdf": str(artwork), "structure_json": str(structure)}

    class ReachedResolver(RuntimeError):
        pass

    monkeypatch.setattr(
        pipeline,
        "PdfReader",
        lambda *_args, **_kwargs: pytest.fail("V2 must not inspect PDF OCG names"),
    )
    monkeypatch.setattr(
        pipeline,
        "optional_content_layers",
        lambda *_args, **_kwargs: pytest.fail("V2 must not inspect PDF OCG names"),
    )
    monkeypatch.setattr(pipeline, "run_illustrator_structure_export", fake_export)
    monkeypatch.setattr(
        pipeline,
        "resolve_structure",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            ReachedResolver("no guessed layer observed")
        ),
    )

    with pytest.raises(ReachedResolver, match="no guessed layer observed"):
        pipeline.preflight_product_v2(
            {
                "code": "NO-OCG-GUESS",
                "slug": "no-ocg-guess",
                "display_name": "不猜图层",
                "source_ai": source.name,
                "template": template.name,
            },
            tmp_path,
            tmp_path / "output",
            False,
            {"enabled": True},
        )

    assert captured["proposal_layers"] == []
    assert captured["source_sha256"] == pipeline.file_sha256(source)


def test_v2_preflight_uses_only_an_explicitly_selected_legacy_proposal_layer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    pipeline = load_pipeline()
    source = tmp_path / "source.ai"
    source.write_bytes(b"native-ai")
    template = tmp_path / "template.json"
    template.write_text(json.dumps({"print_layers": ["印刷"]}), encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_export(*_args, **kwargs):
        captured.update(kwargs)
        export_dir = tmp_path / "export"
        export_dir.mkdir()
        artwork = export_dir / "artwork.pdf"
        structure = export_dir / "structure.json"
        artwork.write_bytes(b"artwork")
        structure.write_text("{}", encoding="utf-8")
        return {"print_pdf": str(artwork), "structure_json": str(structure)}

    class ReachedResolver(RuntimeError):
        pass

    monkeypatch.setattr(
        pipeline,
        "optional_content_layers",
        lambda *_args: pytest.fail("an explicit selection must not be replaced by a layer-name guess"),
    )
    monkeypatch.setattr(pipeline, "run_illustrator_structure_export", fake_export)
    monkeypatch.setattr(
        pipeline,
        "resolve_structure",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(ReachedResolver("selection observed")),
    )

    with pytest.raises(ReachedResolver, match="selection observed"):
        pipeline.preflight_product_v2(
            {
                "code": "LEGACY-LAYER",
                "slug": "legacy-layer",
                "display_name": "人工选层旧稿",
                "source_ai": source.name,
                "template": template.name,
                "proposal_layers": ["客户确认结构层"],
                "proposal_source_sha256": pipeline.file_sha256(source),
            },
            tmp_path,
            tmp_path / "output",
            False,
            {"enabled": True},
        )

    assert captured["proposal_layers"] == ["客户确认结构层"]


@pytest.mark.parametrize(
    "proposal_layers",
    ["结构层", [], [""], ["结构层"] * 17, ["结" * 161]],
)
def test_v2_preflight_rejects_invalid_explicit_proposal_layer_selection(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    proposal_layers,
):
    pipeline = load_pipeline()
    source = tmp_path / "source.ai"
    source.write_bytes(b"native-ai")
    template = tmp_path / "template.json"
    template.write_text(json.dumps({"print_layers": ["印刷"]}), encoding="utf-8")
    monkeypatch.setattr(
        pipeline,
        "run_illustrator_structure_export",
        lambda *_args, **_kwargs: pytest.fail("invalid selection must fail before Illustrator"),
    )

    with pytest.raises(pipeline.PipelineError) as caught:
        pipeline.preflight_product_v2(
            {
                "code": "BAD-LAYER",
                "slug": "bad-layer",
                "display_name": "错误选层",
                "source_ai": source.name,
                "template": template.name,
                "proposal_layers": proposal_layers,
                "proposal_source_sha256": pipeline.file_sha256(source),
            },
            tmp_path,
            tmp_path / "output",
            False,
            {"enabled": True},
        )

    assert caught.value.code == "packaging_structure_selection_invalid"


@pytest.mark.parametrize("selected_hash", [None, "not-a-hash", "0" * 64])
def test_v2_preflight_rejects_missing_or_stale_proposal_layer_source_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    selected_hash,
):
    pipeline = load_pipeline()
    source = tmp_path / "source.ai"
    source.write_bytes(b"native-ai")
    template = tmp_path / "template.json"
    template.write_text(json.dumps({"print_layers": ["印刷"]}), encoding="utf-8")
    monkeypatch.setattr(
        pipeline,
        "run_illustrator_structure_export",
        lambda *_args, **_kwargs: pytest.fail("a stale selection must fail before Illustrator"),
    )
    product = {
        "code": "STALE-LAYER",
        "slug": "stale-layer",
        "display_name": "过期选层",
        "source_ai": source.name,
        "template": template.name,
        "proposal_layers": ["结构层"],
    }
    if selected_hash is not None:
        product["proposal_source_sha256"] = selected_hash

    with pytest.raises(pipeline.PipelineError) as caught:
        pipeline.preflight_product_v2(
            product,
            tmp_path,
            tmp_path / "output",
            False,
            {"enabled": True},
        )

    assert caught.value.code == "packaging_structure_selection_stale"


def test_v2_hold_persists_source_bound_legacy_layer_candidates(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    pipeline = load_pipeline()
    source = tmp_path / "source.ai"
    source.write_bytes(b"native-ai")
    template = tmp_path / "template.json"
    template.write_text(json.dumps({"print_layers": ["印刷"]}), encoding="utf-8")

    def fake_export(*_args, **_kwargs):
        export_dir = tmp_path / "export"
        export_dir.mkdir()
        artwork = export_dir / "artwork.pdf"
        structure = export_dir / "structure.json"
        artwork.write_bytes(b"artwork")
        structure.write_text("{}", encoding="utf-8")
        return {
            "print_pdf": str(artwork),
            "structure_json": str(structure),
            "proposal_layer_candidates": [
                {"name": "结构-A", "stroke_only_path_count": 12},
                {"name": "结构-B", "stroke_only_path_count": 8},
            ],
        }

    class ReviewResolution:
        status = "review_required"
        code = "structure_semantics_missing"
        message = "稿件里没有明确结构语义。"
        resolved = None

        @staticmethod
        def as_dict():
            return {"status": "review_required", "code": "structure_semantics_missing"}

    def fake_preview(_source, destination, **_kwargs):
        preview = Path(destination).with_suffix(".png")
        preview.write_bytes(b"png")
        return preview

    monkeypatch.setattr(pipeline, "run_illustrator_structure_export", fake_export)
    monkeypatch.setattr(pipeline, "resolve_structure", lambda *_args, **_kwargs: ReviewResolution())
    monkeypatch.setattr(pipeline, "render_pdf_thumbnail", fake_preview)

    with pytest.raises(pipeline.PipelineHold) as caught:
        pipeline.preflight_product_v2(
            {
                "code": "CANDIDATES",
                "slug": "candidates",
                "display_name": "候选层旧稿",
                "source_ai": source.name,
                "template": template.name,
            },
            tmp_path,
            tmp_path / "output",
            False,
            {"enabled": True},
        )

    saved = json.loads(caught.value.resolution_path.read_text(encoding="utf-8"))
    candidates = saved["input_candidates"]
    assert candidates["schema"] == "packaging-structure-input-candidates/2"
    assert candidates["source_sha256"] == pipeline.file_sha256(source)
    assert candidates["proposal_layers"] == [
        {
            "id": candidates["proposal_layers"][0]["id"],
            "name": "结构-A",
            "stroke_only_path_count": 12,
        },
        {
            "id": candidates["proposal_layers"][1]["id"],
            "name": "结构-B",
            "stroke_only_path_count": 8,
        },
    ]
    assert candidates["proposal_layers"][0]["id"].startswith("proposal-layer-")
    assert candidates["proposal_layers"][1]["id"].startswith("proposal-layer-")
    assert candidates["proposal_layers"][0]["id"] != candidates["proposal_layers"][1]["id"]


def test_explicit_proposal_layers_preserve_exact_names_and_deduplicate_exact_values():
    pipeline = load_pipeline()
    source_sha256 = "a" * 64

    assert pipeline.explicit_proposal_layers(
        [" 结构-A ", " 结构-A ", "结构-B"],
        source_sha256.upper(),
        source_sha256,
    ) == [" 结构-A ", "结构-B"]


def test_structure_input_candidates_filter_untrusted_entries_and_cap_counts():
    pipeline = load_pipeline()
    payload = pipeline.structure_input_candidates(
        {
            "proposal_layer_candidates": [
                None,
                {"name": {"unexpected": "mapping"}, "stroke_only_path_count": 2},
                {"name": "", "stroke_only_path_count": 2},
                {"name": "结" * 161, "stroke_only_path_count": 2},
                {"name": "布尔计数", "stroke_only_path_count": True},
                {"name": "浮点计数", "stroke_only_path_count": 1.5},
                {"name": "零计数", "stroke_only_path_count": 0},
                {"name": "重名", "stroke_only_path_count": 2, "ambiguous_name": True},
                {"name": " 结构-A ", "stroke_only_path_count": 2_000_000},
                {"name": "结构-A", "stroke_only_path_count": 9},
                {"name": "结构-B", "stroke_only_path_count": 3},
                {"name": " 结构-C ", "stroke_only_path_count": 2_000_000},
            ],
            "proposal_layer_candidates_truncated": True,
        },
        "b" * 64,
    )

    assert payload is not None
    assert payload["truncated"] is True
    assert [candidate["name"] for candidate in payload["proposal_layers"]] == [
        "结构-B",
        " 结构-C ",
    ]
    assert payload["proposal_layers"][0]["stroke_only_path_count"] == 3
    assert payload["proposal_layers"][1]["stroke_only_path_count"] == 1_000_000


def test_structure_input_candidates_publish_bounded_advisory_layer_preview():
    pipeline = load_pipeline()
    source_hash = "f" * 64
    payload = pipeline.structure_input_candidates(
        {
            "page_size_points": [160, 90],
            "proposal_layer_candidates": [
                {
                    "name": "刀线",
                    "stroke_only_path_count": 2,
                    "preview_paths": [
                        {
                            "closed": False,
                            "points": [
                                [10, 20, 10, 20, 20, 30],
                                [40, 50, 30, 40, 40, 50],
                            ],
                        },
                        {"closed": False, "points": [[True, 0, 0, 0, 0, 0]] * 2},
                    ],
                    "preview_truncated": False,
                }
            ],
        },
        source_hash,
    )

    assert payload is not None
    candidate_id = payload["proposal_layers"][0]["id"]
    assert payload["preview"] == {
        "schema": "illustrator-layer-preview/1",
        "page_size_points": [160.0, 90.0],
        "layers": [
            {
                "candidate_id": candidate_id,
                "paths": [
                    {
                        "closed": False,
                        "points": [
                            [10.0, 20.0, 10.0, 20.0, 20.0, 30.0],
                            [40.0, 50.0, 30.0, 40.0, 40.0, 50.0],
                        ],
                    }
                ],
                "truncated": True,
            }
        ],
    }


def test_structure_input_candidates_cap_preview_paths_per_layer():
    pipeline = load_pipeline()
    source_hash = "e" * 64
    path = {
        "closed": False,
        "points": [
            [0, 0, 0, 0, 0, 0],
            [1, 0, 1, 0, 1, 0],
        ],
    }
    payload = pipeline.structure_input_candidates(
        {
            "page_size_points": [160, 90],
            "proposal_layer_candidates": [
                {
                    "name": "刀线",
                    "stroke_only_path_count": 513,
                    "preview_paths": [path] * 513,
                    "preview_truncated": False,
                }
            ],
        },
        source_hash,
    )

    assert payload is not None
    layer = payload["preview"]["layers"][0]
    assert len(layer["paths"]) == 512
    assert layer["truncated"] is True


def test_structure_input_candidates_omit_preview_without_page_size():
    pipeline = load_pipeline()
    payload = pipeline.structure_input_candidates(
        {
            "proposal_layer_candidates": [{
                "name": "刀线",
                "stroke_only_path_count": 1,
                "preview_paths": [{
                    "closed": False,
                    "points": [[10, 20, 10, 20, 20, 30], [40, 50, 30, 40, 40, 50]],
                }],
            }],
        },
        "a" * 64,
    )
    assert payload is not None
    assert "preview" not in payload
    assert payload["proposal_layers"][0]["name"] == "刀线"


def test_structure_input_candidates_drop_short_points_and_honor_global_preview_budget():
    pipeline = load_pipeline()
    two_point_path = {
        "closed": False,
        "points": [[0, 0, 0, 0, 0, 0], [1, 0, 1, 0, 1, 0]],
    }
    payload = pipeline.structure_input_candidates(
        {
            "page_size_points": [160, 90],
            "proposal_layer_candidates": [
                {
                    "name": "短点",
                    "stroke_only_path_count": 1,
                    "preview_paths": [{"closed": False, "points": [[0, 0], [1, 1]]}],
                },
                *[
                    {
                        "name": f"预算层{index}",
                        "stroke_only_path_count": 1,
                        "preview_paths": [two_point_path] * 512,
                    }
                    for index in range(10)
                ],
            ],
        },
        "b" * 64,
    )
    assert payload is not None
    assert payload["proposal_layers"][0]["name"] == "短点"
    layers = payload["preview"]["layers"]
    assert payload["proposal_layers"][0]["id"] not in {
        layer["candidate_id"] for layer in layers
    }
    assert sum(len(layer["paths"]) for layer in layers) == 5000
    assert layers[-1]["truncated"] is True


def test_structure_preview_thumbnail_uses_5600px_budget():
    source = PIPELINE.read_text(encoding="utf-8")
    assert "width_px=5_600" in source
    assert "MAX_RASTER_PIXELS = 32_000_000" in source


def test_structure_input_candidates_return_none_when_every_entry_is_invalid():
    pipeline = load_pipeline()

    assert (
        pipeline.structure_input_candidates(
            {
                "proposal_layer_candidates": [
                    {"name": 7, "stroke_only_path_count": 1},
                    {"name": "无计数"},
                ]
            },
            "c" * 64,
        )
        is None
    )


def test_structure_input_candidates_are_bounded_and_source_bound():
    pipeline = load_pipeline()
    raw_candidates = [
        {"name": f"结构-{index}", "stroke_only_path_count": 1}
        for index in range(129)
    ]

    first = pipeline.structure_input_candidates(
        {"proposal_layer_candidates": raw_candidates},
        "d" * 64,
    )
    second = pipeline.structure_input_candidates(
        {"proposal_layer_candidates": raw_candidates},
        "e" * 64,
    )

    assert first is not None and second is not None
    assert len(first["proposal_layers"]) == 128
    assert first["truncated"] is True
    assert first["proposal_layers"][0]["id"] != second["proposal_layers"][0]["id"]


def test_production_flower_box_outputs_zoomable_white_shots():
    template = json.loads(
        (PACKAGING / "templates" / "flower_box_47_5x47_5x177_5.json").read_text(
            encoding="utf-8"
        )
    )

    assert template["render"]["resolution_x"] >= 3000
    assert template["render"]["resolution_y"] >= 3600


def test_windows_pipe_contract_is_utf8_json_and_request_correlated():
    client = load_agent_client()
    request_id, raw = client.encode_request(
        "run",
        config_path=r"C:\supply\data\mockups\abc\illustrator_input.json",
        exporter="structure",
        timeout_seconds=420,
        request_id="request-1",
    )
    assert request_id == "request-1"
    assert raw.endswith(b"\n")
    parsed = json.loads(raw.decode("utf-8"))
    assert parsed["protocol"] == "beian.illustrator.v1"
    assert parsed["exporter"] == "structure"
    response = client.decode_response(
        json.dumps(
            {
                "protocol": "beian.illustrator.v1",
                "id": "request-1",
                "ok": True,
                "illustrator_version": "30.5.1",
            }
        ).encode("utf-8"),
        "request-1",
    )
    assert response["illustrator_version"] == "30.5.1"


def test_windows_pipe_contract_preserves_agent_error_details():
    client = load_agent_client()
    with pytest.raises(client.IllustratorAgentError) as caught:
        client.decode_response(
            json.dumps(
                {
                    "protocol": "beian.illustrator.v1",
                    "id": "request-2",
                    "ok": False,
                    "code": "illustrator_documents_open",
                    "message": "Illustrator has open documents",
                    "details": {"documents": [{"name": "[recovered].ai"}]},
                }
            ).encode("utf-8"),
            "request-2",
        )
    assert caught.value.code == "illustrator_documents_open"
    assert caught.value.details["documents"][0]["name"] == "[recovered].ai"


@pytest.mark.parametrize(
    ("command", "kwargs", "message"),
    [
        ("unknown", {}, "unsupported"),
        ("run", {"exporter": "structure"}, "config_path"),
        ("run", {"config_path": r"C:\\job.json", "exporter": "other"}, "exporter"),
    ],
)
def test_windows_pipe_contract_rejects_invalid_requests(
    command: str,
    kwargs: dict,
    message: str,
):
    client = load_agent_client()

    with pytest.raises(ValueError, match=message):
        client.encode_request(command, **kwargs)


def test_windows_pipe_contract_clamps_timeout_to_agent_bounds():
    client = load_agent_client()

    _, minimum = client.encode_request("probe", timeout_seconds=0, request_id="minimum")
    _, maximum = client.encode_request("probe", timeout_seconds=9999, request_id="maximum")

    assert json.loads(minimum)["timeout_ms"] == 30_000
    assert json.loads(maximum)["timeout_ms"] == 600_000


@pytest.mark.parametrize(
    "raw",
    [
        b"\xff",
        b"not-json",
        json.dumps(["not", "an", "object"]).encode("utf-8"),
        json.dumps(
            {"protocol": "beian.illustrator.v1", "id": "other", "ok": True}
        ).encode("utf-8"),
    ],
)
def test_windows_pipe_contract_rejects_malformed_or_uncorrelated_responses(raw: bytes):
    client = load_agent_client()

    with pytest.raises(client.IllustratorAgentError) as caught:
        client.decode_response(raw, "request-3")

    assert caught.value.code == "illustrator_agent_protocol_error"


def test_windows_worker_records_agent_success_without_running_a_second_bridge(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    worker = load_worker()
    config_path = tmp_path / "illustrator-input.json"
    result_path = tmp_path / "result.json"
    full_pdf = tmp_path / "full.pdf"
    print_pdf = tmp_path / "print.pdf"
    structure_json = tmp_path / "structure.json"
    config_path.write_text(
        json.dumps(
            {
                "application": str(tmp_path / "Illustrator.exe"),
                "source_ai": str(tmp_path / "source.ai"),
                "full_pdf": str(full_pdf),
                "print_pdf": str(print_pdf),
                "structure_json": str(structure_json),
                "result_json": str(result_path),
            }
        ),
        encoding="utf-8",
    )

    def fake_request(command: str, **kwargs):
        assert command == "run"
        assert kwargs["exporter"] == "structure"
        for path in (full_pdf, print_pdf, structure_json):
            path.write_bytes(b"output")
        result_path.write_text(
            json.dumps(
                {
                    "success": True,
                    "full_pdf": str(full_pdf),
                    "print_pdf": str(print_pdf),
                    "structure_json": str(structure_json),
                }
            ),
            encoding="utf-8",
        )
        return {
            "illustrator_version": "30.5.1",
            "warmup_elapsed_ms": 250,
        }

    monkeypatch.setattr(worker.sys, "platform", "win32")
    monkeypatch.setattr(worker, "request_agent", fake_request)
    monkeypatch.setattr(worker.sys, "argv", [str(WORKER), str(config_path)])

    assert worker.main() == 0
    result = json.loads(result_path.read_text(encoding="utf-8"))
    assert result["illustrator_version"] == "30.5.1"
    assert result["warmup_elapsed_s"] == 0.25
    assert json.loads(config_path.read_text(encoding="utf-8"))["document_already_open"] is False


def test_windows_worker_preserves_agent_error_code_and_does_not_fabricate_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    worker = load_worker()
    config_path = tmp_path / "illustrator-input.json"
    result_path = tmp_path / "result.json"
    config_path.write_text(
        json.dumps(
            {
                "application": str(tmp_path / "Illustrator.exe"),
                "source_ai": str(tmp_path / "source.ai"),
                "full_pdf": str(tmp_path / "full.pdf"),
                "print_pdf": str(tmp_path / "print.pdf"),
                "result_json": str(result_path),
            }
        ),
        encoding="utf-8",
    )

    def fail_request(*_args, **_kwargs):
        raise worker.IllustratorAgentError(
            "illustrator_documents_open",
            "Illustrator has open documents",
            details={"documents": [{"name": "[recovered].ai"}]},
        )

    monkeypatch.setattr(worker.sys, "platform", "win32")
    monkeypatch.setattr(worker, "request_agent", fail_request)
    monkeypatch.setattr(worker.sys, "argv", [str(WORKER), str(config_path)])

    assert worker.main() == 2
    assert not result_path.exists()
    stderr = capsys.readouterr().err
    payload = json.loads(stderr.strip().splitlines()[-1])
    assert payload["kind"] == "illustrator_agent_error"
    assert payload["code"] == "illustrator_documents_open"
    assert payload["details"]["documents"][0]["name"] == "[recovered].ai"


def test_windows_bridge_uses_official_com_jsx_entrypoint_and_guards_open_docs():
    source = WINDOWS_RUNNER.read_text(encoding="utf-8")
    assert 'GetObject(, "Illustrator.Application")' in source
    assert 'CreateObject("Illustrator.Application")' not in source
    assert "DoJavaScriptFile" in source
    assert "appRef.Documents.Count <> 0" in source
    assert 'mode = "close-owned"' in source
    assert '"DOCUMENT" & vbTab' in source
    assert "Shell.Application" not in source


def test_agent_and_curve_adapter_changes_invalidate_pipeline_cache(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    pipeline = load_pipeline()
    source = tmp_path / "source.ai"
    template = tmp_path / "template.json"
    client = tmp_path / "illustrator_agent.py"
    server = tmp_path / "illustrator-agent.ps1"
    curve_helper = tmp_path / "curve_flatten.js"
    source.write_bytes(b"ai")
    template.write_text("{}", encoding="utf-8")
    client.write_text("client-v1", encoding="utf-8")
    server.write_text("server-v1", encoding="utf-8")
    curve_helper.write_text("curve-v1", encoding="utf-8")
    monkeypatch.setattr(pipeline, "ILLUSTRATOR_AGENT_CLIENT", client)
    monkeypatch.setattr(pipeline, "ILLUSTRATOR_AGENT_SERVER", server)
    monkeypatch.setattr(pipeline, "ILLUSTRATOR_CURVE_HELPER", curve_helper)

    first = pipeline.job_fingerprint(source, template, {"structure_engine": "v2"})
    client.write_text("client-v2", encoding="utf-8")
    second = pipeline.job_fingerprint(source, template, {"structure_engine": "v2"})
    server.write_text("server-v2", encoding="utf-8")
    third = pipeline.job_fingerprint(source, template, {"structure_engine": "v2"})
    curve_helper.write_text("curve-v2", encoding="utf-8")
    fourth = pipeline.job_fingerprint(source, template, {"structure_engine": "v2"})

    assert first != second
    assert second != third
    assert third != fourth


def test_windows_worker_has_no_session_zero_launch_or_direct_com_path():
    source = WORKER.read_text(encoding="utf-8")
    assert "request_agent(" in source
    assert "subprocess.Popen" not in source
    assert "run_export.vbs" not in source
    assert "CreateObject" not in source


def test_session_one_agent_is_acl_bounded_timeout_safe_and_fixed_exporter_only():
    source = AGENT_SCRIPT.read_text(encoding="utf-8")
    assert "NamedPipeServerStream" in source
    assert "PipeSecurity" in source
    assert "S-1-5-18" in source
    assert "UTF8Encoding" in source
    assert "illustrator-agent-$PipeHash.lock" in source
    assert "illustrator-execution.lock" in source
    assert "illustrator-fault.json" in source
    assert "beian.illustrator.fault.v1" in source
    assert "[System.IO.FileShare]::None" in source
    assert "System.Threading.Mutex" not in source
    assert "SessionId" in source
    assert "MainWindowHandle" in source
    assert "Start-Process -FilePath $Executable" in source
    assert "$process.WaitForExit($sliceMs)" in source
    assert 'Write-Heartbeat "busy"' in source
    assert "Read-PipeRequestLine" in source
    assert ".ReadAsync(" in source
    assert "request body is too large" in source
    assert "HeartbeatName" in source
    assert "ExpectedUserSid" in source
    assert "script_sha256" in source
    assert "release_version" in source
    assert 'Write-Heartbeat "faulted"' in source
    assert "illustrator_recovery_failed" in source
    assert 'Write-AgentFaultFence "active" "illustrator_execution_incomplete" $requestId' in source
    assert 'Write-AgentFaultFence "faulted" $code $requestId' in source
    assert "function Read-AgentFaultFence" in source
    assert "function Import-AgentFaultFence" in source
    assert "function Get-AgentHeartbeatState" in source
    assert "function Assert-AgentFenceAfterExecutionLock" in source
    assert "Assert-AgentNotFaulted" in source
    import_fence = source[source.index("function Import-AgentFaultFence") : source.index("function Set-AgentFaultedFromFence")]
    assert '$fence.State -eq "faulted"' in import_fence
    assert '$fence.State -eq "active"' not in import_fence
    heartbeat_state = source[source.index("function Get-AgentHeartbeatState") : source.index("function Write-AgentFaultFence")]
    assert "[System.IO.FileShare]::None" in heartbeat_state
    assert "catch [System.IO.IOException]" in heartbeat_state
    assert 'return "busy"' in heartbeat_state
    assert 'Write-AgentFaultFence "faulted"' in heartbeat_state
    request_loop = source[source.index("$line = Read-PipeRequestLine") : source.index("$response = [ordered]@{")]
    assert request_loop.index("Assert-AgentNotFaulted") < request_loop.index("Enter-ExecutionLock $deadline")
    assert request_loop.index("Enter-ExecutionLock $deadline") < request_loop.index("Assert-AgentFenceAfterExecutionLock")
    assert request_loop.index("Assert-AgentFenceAfterExecutionLock") < request_loop.index('Write-AgentFaultFence "active"')
    assert source.index('Write-AgentFaultFence "active"') < source.index("Invoke-AgentRequest $request $deadline")
    assert source.index("Clear-AgentFaultFence", source.index("Invoke-AgentRequest $request $deadline")) < source.index(
        "$writer.WriteLine(($response", source.index("Invoke-AgentRequest $request $deadline")
    )
    assert "$process.Kill()" in source
    assert "$process.WaitForExit(5000)" in source
    invoke_cscript = source[source.index("function Invoke-Cscript") : source.index("function Convert-ProbeOutput")]
    assert "try {" in invoke_cscript
    assert "} finally {" in invoke_cscript
    assert "$processStarted -and -not $exitProven" in invoke_cscript
    assert "cscript.exe could not be terminated safely after an agent-side failure" in invoke_cscript
    assert invoke_cscript.index('Write-Heartbeat "busy"') < invoke_cscript.index("} finally {")
    assert invoke_cscript.index("$process.Kill()", invoke_cscript.index("} finally {")) < invoke_cscript.index(
        "$process.WaitForExit(5000)", invoke_cscript.index("} finally {")
    )
    ensure_illustrator = source[
        source.index("function Ensure-Illustrator") : source.index("function Assert-NoOpenDocuments")
    ]
    assert '$probeCode = [string]$_.Exception.Data["AgentCode"]' in ensure_illustrator
    assert 'if ($probeCode -eq "illustrator_recovery_failed")' in ensure_illustrator
    assert ensure_illustrator.index('if ($probeCode -eq "illustrator_recovery_failed")') < ensure_illustrator.index(
        "$lastMessage = $_.Exception.Message"
    )
    run_request = source[source.index("function Invoke-RunRequest") : source.index("function Invoke-ProbeRequest")]
    post_run_probe = run_request[
        run_request.index("try {\n    $after = Invoke-BridgeProbe") : run_request.index(
            "if ([int]$after.document_count"
        )
    ]
    assert '$originalCode = [string]$original.Data["AgentCode"]' in post_run_probe
    assert 'if ($originalCode -eq "illustrator_recovery_failed")' in post_run_probe
    assert post_run_probe.index('if ($originalCode -eq "illustrator_recovery_failed")') < post_run_probe.index(
        "Restore-OwnedDocumentState"
    )
    assert 'Throw-AgentFailure "illustrator_recovery_failed" "Timed-out cscript.exe did not exit after termination"' in source
    assert 'Throw-AgentFailure "illustrator_recovery_failed" "Illustrator cleanup could not be verified before the deadline"' in source
    enter_lock = source[source.index("function Enter-ExecutionLock") : source.index("function New-PipeServer")]
    first_deadline = enter_lock.index("Get-RemainingMilliseconds")
    acquire = enter_lock.index("[System.IO.FileStream]::new")
    second_deadline = enter_lock.index("Get-RemainingMilliseconds", acquire)
    assert first_deadline < acquire < second_deadline
    assert "$lock.Dispose()" in enter_lock
    read_request = source[source.index("function Read-PipeRequestLine") : source.index("function Enter-ExecutionLock")]
    assert read_request.count(".ReadAsync(") == 1
    assert '$sliceMs = [Math]::Min($HeartbeatIntervalMs, $remainingMs)' in read_request
    assert 'Write-Heartbeat "busy"' in read_request
    assert '$nextHeartbeatAt = [DateTime]::UtcNow.AddMilliseconds($HeartbeatIntervalMs)' in enter_lock
    assert 'Write-Heartbeat "busy"' in enter_lock
    assert '"export_structure.jsx"' in source
    assert '"export_ai.jsx"' in source
    assert 'Join-Path $ExporterRoot "curve_flatten.js"' in source
    assert "$source.Replace($include, $helper)" in source
    assert "DoJavaScriptFile" not in source
    assert "Illustrator.Application" not in source


def test_agent_task_is_interactive_token_single_instance_and_passwordless():
    source = AGENT_INSTALLER.read_text(encoding="utf-8")
    assert "New-ScheduledTaskTrigger -AtLogOn" in source
    assert "-LogonType Interactive" in source
    assert "InteractiveToken" in source
    assert 'MultipleInstances = "IgnoreNew"' in source
    assert "ExecutionTimeLimit = [TimeSpan]::Zero" in source
    assert "RestartCount = 60" in source
    assert "$settingsArguments.RestartCount = 3" in source
    assert "-Password" not in source
    assert "New-Service" not in source
    assert source.index("Stop-ScheduledTask") < source.index("Register-ScheduledTask")
    assert "HeartbeatName" in source
    assert "ExpectedUserSid" in source
    assert "Set-AgentRuntimeAcl" in source
    assert "Stop-AgentTaskAndWait" in source
    assert "Get-AgentHeartbeatPid" in source
    assert "[switch]$Quiesce" in source
    assert "if ($Quiesce -or $Uninstall)" in source
    assert "ILLUSTRATOR_AGENT_TASK quiesced" in source
    assert "$activeSid.Value -eq $interactiveSid.Value" in source
    assert "Stop-AgentTaskAndWait $TaskName $heartbeat" in source
    assert "ClearFaultFence" in source
    assert "Assert-FaultClearAuthority" in source
    assert "Assert-FaultClearWorkspaceIdle" in source
    assert "illustrator-fault.json" in source
    assert "S-1-5-18" in source
    assert 'Get-Process -Name "Illustrator", "AIRobin", "cscript", "wscript"' in source


def test_windows_l1_smoke_requires_an_explicitly_idle_production_agent():
    source = AGENT_SMOKE.read_text(encoding="utf-8")
    assert '$agentState -eq "idle"' in source
    assert '$agentState -ne "busy"' not in source
    assert '$agentState -eq "faulted"' in source
    assert "interactive administrator must verify the desktop before L1" in source
    assert '"Administrator"' not in source


def test_temporary_agent_task_supports_scheduler_owned_expiry_after_hard_cancel():
    installer = AGENT_INSTALLER.read_text(encoding="utf-8")
    agent = AGENT_SCRIPT.read_text(encoding="utf-8")

    assert "[DateTime]$ExpiresAt" in installer
    assert "$logonTrigger.EndBoundary" in installer
    assert "-Trigger $taskTriggers" in installer
    assert "DeleteExpiredTaskAfter" in installer
    assert '"-ExpiresAtUtc"' in installer
    assert "$settingsArguments.ExecutionTimeLimit = $temporaryLimit" in installer
    assert "$settingsArguments.DeleteExpiredTaskAfter = New-TimeSpan -Minutes 10" in installer
    assert "expiry must be in the future" in installer
    assert "[string]$ExpiresAtUtc" in agent
    assert "$AgentExpiresAt = [DateTimeOffset]::Parse($ExpiresAtUtc).UtcDateTime" in agent
    assert "$deadline -gt $AgentExpiresAt" in agent
    assert 'Throw-AgentFailure "illustrator_agent_expiring"' in agent
    assert ":AgentLoop while ($true)" in agent
    assert "break AgentLoop" in agent


def test_agent_client_binds_pipe_to_current_heartbeat_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    client = load_agent_client()
    agent_script = tmp_path / "illustrator-agent.ps1"
    version_file = tmp_path / "VERSION"
    agent_script.write_text("agent-v1", encoding="utf-8")
    version_file.write_text("0.20.0.0\n", encoding="utf-8")
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    heartbeat_name = "illustrator-agent-test.json"
    heartbeat = {
        "protocol": client.PROTOCOL,
        "pipe": "test-pipe",
        "pid": 4321,
        "session_id": 1,
        "state": "idle",
        "updated_at": "2099-01-01T00:00:00+00:00",
        "script_sha256": client._file_sha256(agent_script),
        "release_version": "0.20.0.0",
    }
    runtime.joinpath(heartbeat_name).write_text(json.dumps(heartbeat), encoding="utf-8")
    monkeypatch.setenv("WB_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(client, "AGENT_SCRIPT", agent_script)
    monkeypatch.setattr(client, "VERSION_FILE", version_file)
    monkeypatch.setattr(client.time, "time", lambda: 4070908800.0)

    assert client._expected_agent_pid(heartbeat_name, "test-pipe") == 4321


def test_agent_heartbeat_timing_contract_is_consistent_across_all_three_layers():
    client = load_agent_client()
    server = SERVER_AGENT.read_text(encoding="utf-8")
    powershell = AGENT_SCRIPT.read_text(encoding="utf-8")

    assert client.HEARTBEAT_STALE_SECONDS == 30
    assert client.HEARTBEAT_FUTURE_SKEW_SECONDS == 5
    assert "ILLUSTRATOR_AGENT_HEARTBEAT_INTERVAL_MS = 5_000" in server
    assert "ILLUSTRATOR_AGENT_STALE_MS = 30_000" in server
    assert "ILLUSTRATOR_AGENT_FUTURE_SKEW_MS = 5_000" in server
    assert "$HeartbeatIntervalMs = 5000" in powershell


@pytest.mark.parametrize(
    ("heartbeat_age_seconds", "accepted"),
    [
        (20.001, True),
        (30.001, False),
        (-5.0, True),
        (-5.001, False),
    ],
)
def test_agent_client_applies_bounded_stale_and_future_heartbeat_windows(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    heartbeat_age_seconds: float,
    accepted: bool,
):
    client = load_agent_client()
    agent_script = tmp_path / "illustrator-agent.ps1"
    version_file = tmp_path / "VERSION"
    agent_script.write_text("agent-v1", encoding="utf-8")
    version_file.write_text("0.20.0.0\n", encoding="utf-8")
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    heartbeat_name = "illustrator-agent-test.json"
    heartbeat_epoch = 4_070_908_800.0
    heartbeat = {
        "protocol": client.PROTOCOL,
        "pipe": "test-pipe",
        "pid": 4321,
        "session_id": 1,
        "state": "idle",
        "updated_at": "2099-01-01T00:00:00+00:00",
        "script_sha256": client._file_sha256(agent_script),
        "release_version": "0.20.0.0",
    }
    runtime.joinpath(heartbeat_name).write_text(json.dumps(heartbeat), encoding="utf-8")
    monkeypatch.setenv("WB_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(client, "AGENT_SCRIPT", agent_script)
    monkeypatch.setattr(client, "VERSION_FILE", version_file)
    monkeypatch.setattr(client.time, "time", lambda: heartbeat_epoch + heartbeat_age_seconds)

    if accepted:
        assert client._expected_agent_pid(heartbeat_name, "test-pipe") == 4321
    else:
        with pytest.raises(client.IllustratorAgentError) as caught:
            client._expected_agent_pid(heartbeat_name, "test-pipe")
        assert caught.value.code == "illustrator_agent_protocol_error"


def test_agent_client_rejects_faulted_heartbeat(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    client = load_agent_client()
    agent_script = tmp_path / "illustrator-agent.ps1"
    version_file = tmp_path / "VERSION"
    agent_script.write_text("agent-v1", encoding="utf-8")
    version_file.write_text("0.20.0.0\n", encoding="utf-8")
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    heartbeat_name = "illustrator-agent-test.json"
    runtime.joinpath(heartbeat_name).write_text(
        json.dumps(
            {
                "protocol": client.PROTOCOL,
                "pipe": "test-pipe",
                "pid": 4321,
                "session_id": 1,
                "state": "faulted",
                "last_code": "illustrator_recovery_failed",
                "updated_at": "2099-01-01T00:00:00+00:00",
                "script_sha256": client._file_sha256(agent_script),
                "release_version": "0.20.0.0",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("WB_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(client, "AGENT_SCRIPT", agent_script)
    monkeypatch.setattr(client, "VERSION_FILE", version_file)
    monkeypatch.setattr(client.time, "time", lambda: 4070908800.0)

    with pytest.raises(client.IllustratorAgentError) as caught:
        client._expected_agent_pid(heartbeat_name, "test-pipe")

    assert caught.value.code == "illustrator_agent_faulted"
    assert caught.value.details["last_code"] == "illustrator_recovery_failed"


@pytest.mark.parametrize(
    ("returncode", "stderr", "expected_code", "expected_message"),
    [
        (6, "Illustrator COM unavailable", "illustrator_unavailable", "没有启动成功"),
        (2, "Illustrator semantic export requires no other open documents", "illustrator_documents_open", "其他稿件"),
        (3, "Illustrator export timed out after 30s", "illustrator_timeout", "处理超时"),
        (
            6,
            '{"kind":"illustrator_agent_error","ok":false,"code":"illustrator_agent_offline","message":"pipe unavailable","details":{}}',
            "illustrator_agent_offline",
            "桌面代理未在线",
        ),
        (
            2,
            '{"kind":"illustrator_agent_error","ok":false,"code":"illustrator_configuration_mismatch","message":"path changed","details":{}}',
            "illustrator_configuration_mismatch",
            "配置已变化",
        ),
        (
            2,
            '{"kind":"illustrator_agent_error","ok":false,"code":"illustrator_bridge_failed","message":"JSX failed","details":{}}',
            "illustrator_bridge_failed",
            "桌面桥执行失败",
        ),
        (
            6,
            '{"kind":"illustrator_agent_error","ok":false,"code":"illustrator_recovery_failed","message":"cleanup failed","details":{}}',
            "illustrator_recovery_failed",
            "自动清理失败",
        ),
        (
            6,
            '{"kind":"illustrator_agent_error","ok":false,"code":"illustrator_process_identity_mismatch","message":"wrong executable","details":{}}',
            "illustrator_process_identity_mismatch",
            "进程与开工板路径不一致",
        ),
    ],
)
def test_structure_export_failure_has_actionable_public_contract(
    returncode: int,
    stderr: str,
    expected_code: str,
    expected_message: str,
):
    pipeline = load_pipeline()
    error = pipeline.illustrator_export_failure(
        operation="structure", returncode=returncode, stderr=stderr
    )

    payload = error.as_dict()
    assert payload["code"] == expected_code
    assert expected_message in payload["error"]
    assert "日志=" not in payload["error"]
    assert payload["cause"]
    assert payload["fix"]


def test_legacy_normalize_uses_the_same_agent_failure_contract_without_structure_wording():
    pipeline = load_pipeline()
    error = pipeline.illustrator_export_failure(
        operation="normalize",
        returncode=2,
        stderr="worker returned malformed result",
    )

    payload = error.as_dict()
    assert payload["code"] == "illustrator_normalize_failed"
    assert payload["error"] == "Illustrator 标准化失败，请重新打样"


def test_structure_export_failure_keeps_private_cause_out_of_public_message():
    pipeline = load_pipeline()
    error = pipeline.illustrator_export_failure(
        operation="structure",
        returncode=2,
        stderr=r"JSX failed at C:\supply\data\mockups\secret\illustrator.log",
    )

    payload = error.as_dict()
    assert r"C:\supply" not in payload["error"]
    assert r"C:\supply" in payload["cause"]


@pytest.mark.parametrize(
    "diagnostic",
    [
        "Configured artwork layer not found: 印刷",
        "Cannot set artwork layer visibility: 印刷",
        "Cannot fully restore artwork layers: 印刷:visibility did not change",
    ],
)
def test_structure_export_maps_artwork_layer_failures_without_blaming_structure_marks(
    diagnostic: str,
):
    pipeline = load_pipeline()
    error = pipeline.illustrator_export_failure(
        operation="structure",
        returncode=4,
        result={"success": False, "error": diagnostic},
    )

    payload = error.as_dict()
    assert payload["code"] == "illustrator_artwork_layers_invalid"
    assert payload["error"] == "Illustrator 无法按模板隔离印刷图层，请检查稿件图层后重试"
    assert "顶层印刷层" in payload["fix"]
    assert "packaging:cut" not in payload["fix"]


@pytest.mark.parametrize(
    ("returncode", "result", "expected_code"),
    [
        (0, {"success": False, "semantic_errors": ["missing front"]}, "illustrator_structure_invalid"),
        (
            5,
            {
                "success": False,
                "semantic_errors": ["structure_face_mapping_incomplete"],
                "missing_outputs": ["print_pdf"],
            },
            "illustrator_output_incomplete",
        ),
        (0, None, "illustrator_structure_export_failed"),
    ],
)
def test_structure_export_maps_invalid_or_incomplete_result_contracts(
    returncode: int,
    result: dict | None,
    expected_code: str,
):
    pipeline = load_pipeline()

    error = pipeline.illustrator_export_failure(
        operation="structure",
        returncode=returncode,
        stdout="worker returned malformed result" if result is None else "",
        result=result,
    )

    assert error.as_dict()["code"] == expected_code


def test_structure_export_missing_application_has_actionable_public_contract(tmp_path: Path):
    pipeline = load_pipeline()
    source = tmp_path / "box.ai"
    source.write_bytes(b"ai")

    with pytest.raises(pipeline.PipelineError) as caught:
        pipeline.run_illustrator_structure_export(
            source,
            tmp_path / "project",
            {"application": str(tmp_path / "missing-Illustrator.exe")},
        )

    payload = caught.value.as_dict()
    assert payload["code"] == "illustrator_not_found"
    assert "重新扫描" in payload["error"]
    assert str(tmp_path) not in payload["error"]
