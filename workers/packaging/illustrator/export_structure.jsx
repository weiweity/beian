#include "curve_flatten.js"

function readUtf8(pathValue) {
    var file = new File(pathValue);
    file.encoding = "UTF-8";
    if (!file.open("r")) {
        throw new Error("Cannot open config: " + pathValue);
    }
    var text = file.read();
    file.close();
    return text;
}

function writeUtf8(pathValue, text) {
    var file = new File(pathValue);
    file.encoding = "UTF-8";
    if (!file.open("w")) {
        throw new Error("Cannot write result: " + pathValue);
    }
    file.write(text);
    file.close();
}

function appendUtf8(pathValue, text) {
    var file = new File(pathValue);
    file.encoding = "UTF-8";
    if (!file.open("a")) {
        return;
    }
    file.writeln(text);
    file.close();
}

function jsonEscape(value) {
    return String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t");
}

function jsonStringify(value) {
    if (value === null) {
        return "null";
    }
    var valueType = typeof value;
    if (valueType === "string") {
        return '"' + jsonEscape(value) + '"';
    }
    if (valueType === "number" || valueType === "boolean") {
        return String(value);
    }
    var index;
    var parts = [];
    if (value instanceof Array) {
        for (index = 0; index < value.length; index += 1) {
            parts.push(jsonStringify(value[index]));
        }
        return "[" + parts.join(",") + "]";
    }
    for (var key in value) {
        if (value.hasOwnProperty(key) && typeof value[key] !== "undefined") {
            parts.push('"' + jsonEscape(key) + '":' + jsonStringify(value[key]));
        }
    }
    return "{" + parts.join(",") + "}";
}

function savePdf(documentRef, pathValue) {
    var output = new File(pathValue);
    if (output.exists) {
        output.remove();
    }
    var options = new PDFSaveOptions();
    options.preserveEditability = false;
    options.acrobatLayers = false;
    options.generateThumbnails = false;
    options.optimization = true;
    options.viewAfterSaving = false;
    options.artboardRange = "1";
    documentRef.saveAs(output, options);
}

function exactAssignment(value) {
    var text = String(value || "").toLowerCase();
    var prefix = "packaging:";
    if (text.indexOf(prefix) !== 0) {
        return null;
    }
    var assignment = text.substring(prefix.length);
    if (
        assignment === "cut" ||
        assignment === "crease" ||
        assignment === "perforation" ||
        assignment === "glue" ||
        assignment === "ignore"
    ) {
        return assignment;
    }
    return null;
}

function configuredAssignment(config, groupName, key) {
    if (!config.semantic_assignments || !config.semantic_assignments[groupName]) {
        return null;
    }
    var mapping = config.semantic_assignments[groupName];
    if (!mapping.hasOwnProperty(key)) {
        return null;
    }
    return exactAssignment("packaging:" + mapping[key]);
}

function spotName(item) {
    try {
        if (item.stroked && item.strokeColor && item.strokeColor.typename === "SpotColor") {
            return item.strokeColor.spot.name;
        }
    } catch (error) {
        return null;
    }
    return null;
}

function assignmentOf(item, config) {
    var assignment = exactAssignment(item.note);
    if (assignment !== null) {
        return assignment;
    }
    assignment = exactAssignment(item.name);
    if (assignment !== null) {
        return assignment;
    }
    assignment = exactAssignment(item.layer ? item.layer.name : "");
    if (assignment !== null) {
        return assignment;
    }
    var layerName = item.layer ? item.layer.name : "";
    assignment = configuredAssignment(config, "layers", layerName);
    if (assignment !== null) {
        return assignment;
    }
    var name = spotName(item);
    if (name !== null) {
        assignment = configuredAssignment(config, "spots", name);
        if (assignment !== null) {
            return assignment;
        }
    }
    return null;
}

function configuredProposalLayer(item, config) {
    if (!item.layer || !config.proposal_layers || !(config.proposal_layers instanceof Array)) {
        return false;
    }
    var layerName = String(item.layer.name || "");
    for (var index = 0; index < config.proposal_layers.length; index += 1) {
        if (layerName === String(config.proposal_layers[index] || "")) {
            // Migration proposals are deliberately narrower than legacy layer
            // selection: converted text is normally filled artwork, while
            // structural paths are stroke-only.  This is only a proposal and
            // can never bypass the six-face human confirmation gate.
            return item.stroked && !item.filled;
        }
    }
    return false;
}

function proposalLayerKey(layer) {
    if (!layer) {
        return null;
    }
    var parts = [];
    var current = layer;
    var guard = 0;
    while (current && guard < 32) {
        var parent = null;
        try {
            parent = current.parent;
        } catch (error) {
            parent = null;
        }
        var position = -1;
        try {
            if (parent && parent.layers) {
                for (var index = 0; index < parent.layers.length; index += 1) {
                    if (parent.layers[index] === current) {
                        position = index;
                        break;
                    }
                }
            }
        } catch (error) {
            position = -1;
        }
        if (position < 0) {
            try {
                position = Number(current.zOrderPosition);
            } catch (error) {
                position = -1;
            }
        }
        if (!isFinite(position) || position < 0 || Math.floor(position) !== position) {
            return null;
        }
        parts.unshift(String(position));
        if (!parent || String(parent.typename || "") !== "Layer") {
            break;
        }
        current = parent;
        guard += 1;
    }
    return parts.length > 0 ? parts.join("/") : null;
}

function roundedPreviewNumber(value) {
    return Math.round(Number(value) * 1000) / 1000;
}

function proposalPreviewPath(item, artboardLeft, artboardTop) {
    try {
        var points = item.pathPoints;
        if (!points || points.length < 2 || points.length > 256) {
            return null;
        }
        var previewPoints = [];
        for (var index = 0; index < points.length; index += 1) {
            var anchor = structurePoint(points[index].anchor, artboardLeft, artboardTop);
            var left = structurePoint(points[index].leftDirection, artboardLeft, artboardTop);
            var right = structurePoint(points[index].rightDirection, artboardLeft, artboardTop);
            var values = [anchor[0], anchor[1], left[0], left[1], right[0], right[1]];
            for (var valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
                if (!isFinite(values[valueIndex]) || Math.abs(values[valueIndex]) > 10000000) {
                    return null;
                }
                values[valueIndex] = roundedPreviewNumber(values[valueIndex]);
            }
            previewPoints.push(values);
        }
        return {closed: Boolean(item.closed), points: previewPoints};
    } catch (error) {
        return null;
    }
}

var MAX_PROPOSAL_PREVIEW_PATHS = 5000;
var MAX_PROPOSAL_PREVIEW_POINTS = 20000;
var MAX_PROPOSAL_PREVIEW_PATHS_PER_LAYER = 512;

function appendProposalPreview(candidate, item, artboardLeft, artboardTop, budget) {
    if (!budget || typeof budget.paths !== "number" || typeof budget.points !== "number") {
        return;
    }
    if (!(candidate.preview_paths instanceof Array)) {
        candidate.preview_paths = [];
        candidate.preview_truncated = false;
    }
    var preview = proposalPreviewPath(item, artboardLeft, artboardTop);
    if (
        preview === null ||
        candidate.preview_paths.length >= MAX_PROPOSAL_PREVIEW_PATHS_PER_LAYER ||
        budget.paths >= MAX_PROPOSAL_PREVIEW_PATHS ||
        budget.points + preview.points.length > MAX_PROPOSAL_PREVIEW_POINTS
    ) {
        candidate.preview_truncated = true;
        return;
    }
    candidate.preview_paths.push(preview);
    budget.paths += 1;
    budget.points += preview.points.length;
}

function recordProposalLayerCandidate(candidates, layerKeys, item, artboardLeft, artboardTop, previewBudget) {
    if (!item.layer || !item.stroked || item.filled) {
        return false;
    }
    var layerName = String(item.layer.name || "");
    var layerKey = proposalLayerKey(item.layer);
    if (layerName.length === 0 || layerKey === null) {
        return false;
    }
    for (var keyIndex = 0; keyIndex < layerKeys.length; keyIndex += 1) {
        if (layerKeys[keyIndex] === layerKey) {
            candidates[keyIndex].stroke_only_path_count += 1;
            appendProposalPreview(candidates[keyIndex], item, artboardLeft, artboardTop, previewBudget);
            return false;
        }
    }
    var ambiguousName = false;
    for (var index = 0; index < candidates.length; index += 1) {
        if (candidates[index].name === layerName) {
            candidates[index].ambiguous_name = true;
            ambiguousName = true;
        }
    }
    // Layer inventory is only a bounded menu for a later human decision.  It
    // never selects structure and never changes the exported edge set.
    if (candidates.length >= 128) {
        return true;
    }
    var candidate = {
        name: layerName,
        stroke_only_path_count: 1
    };
    if (ambiguousName) {
        candidate.ambiguous_name = true;
    }
    appendProposalPreview(candidate, item, artboardLeft, artboardTop, previewBudget);
    candidates.push(candidate);
    layerKeys.push(layerKey);
    return false;
}

function recordPreviewPlateCandidate(plates, plateKeys, proposalLayerKeys, item, artboardLeft, artboardTop, previewBudget) {
    if (!item.layer || (item.stroked && !item.filled)) {
        return false;
    }
    var layerName = String(item.layer.name || "");
    var layerKey = proposalLayerKey(item.layer);
    if (layerName.length === 0 || layerKey === null) {
        return false;
    }
    for (var proposalIndex = 0; proposalIndex < proposalLayerKeys.length; proposalIndex += 1) {
        if (proposalLayerKeys[proposalIndex] === layerKey) {
            return false;
        }
    }
    for (var keyIndex = 0; keyIndex < plateKeys.length; keyIndex += 1) {
        if (plateKeys[keyIndex] === layerKey) {
            appendProposalPreview(plates[keyIndex], item, artboardLeft, artboardTop, previewBudget);
            return false;
        }
    }
    var ambiguousName = false;
    for (var index = 0; index < plates.length; index += 1) {
        if (plates[index].name === layerName) {
            plates[index].ambiguous_name = true;
            ambiguousName = true;
        }
    }
    if (plates.length >= 128) {
        return true;
    }
    var plate = {name: layerName};
    if (ambiguousName) {
        plate.ambiguous_name = true;
    }
    appendProposalPreview(plate, item, artboardLeft, artboardTop, previewBudget);
    plates.push(plate);
    plateKeys.push(layerKey);
    return false;
}

function samePoint(left, right) {
    return Math.abs(left[0] - right[0]) <= 0.001 && Math.abs(left[1] - right[1]) <= 0.001;
}

function hasCurve(currentPoint, nextPoint) {
    return !samePoint(currentPoint.rightDirection, currentPoint.anchor) ||
        !samePoint(nextPoint.leftDirection, nextPoint.anchor);
}

function uniquePush(values, value) {
    for (var index = 0; index < values.length; index += 1) {
        if (values[index] === value) {
            return;
        }
    }
    values.push(value);
}

function hasFatalStructureError(errors) {
    for (var index = 0; index < errors.length; index += 1) {
        if (errors[index] === "structure_curve_complexity_exceeded" || errors[index] === "structure_limit_exceeded") {
            return true;
        }
    }
    return false;
}

function structurePoint(raw, artboardLeft, artboardTop) {
    return [raw[0] - artboardLeft, artboardTop - raw[1]];
}

function exportSemanticPath(item, pathIndex, assignment, structure, errors, artboardLeft, artboardTop) {
    var points = item.pathPoints;
    if (!points || points.length < 2) {
        uniquePush(errors, "structure_path_too_short");
        return 0;
    }
    var segmentCount = item.closed ? points.length : points.length - 1;
    var localVertices = [];
    var localEdges = [];
    var localRepairs = [];
    var firstVertexId = null;
    var previousVertexId = null;
    var vertexIndex = 0;
    var pointIndex;
    for (pointIndex = 0; pointIndex < segmentCount; pointIndex += 1) {
        var nextIndex = (pointIndex + 1) % points.length;
        var curved = hasCurve(points[pointIndex], points[nextIndex]);
        var flattened = curved ? flattenCubicSegment(
            points[pointIndex].anchor,
            points[pointIndex].rightDirection,
            points[nextIndex].leftDirection,
            points[nextIndex].anchor,
            structure.source.geometry.curve_tolerance,
            12
        ) : [points[pointIndex].anchor, points[nextIndex].anchor];
        if (flattened === null || flattened.length - 1 > 256 || localEdges.length + flattened.length - 1 > 4096) {
            uniquePush(errors, "structure_curve_complexity_exceeded");
            return 0;
        }
        if (curved) {
            localRepairs.push({
                kind: "bezier_flatten",
                source_ref: "path:" + pathIndex + "/segment:" + pointIndex,
                output_segments: flattened.length - 1
            });
        }
        var currentVertexId = previousVertexId;
        if (currentVertexId === null) {
            currentVertexId = "v-" + pathIndex + "-" + vertexIndex;
            vertexIndex += 1;
            var firstPoint = structurePoint(flattened[0], artboardLeft, artboardTop);
            localVertices.push({id: currentVertexId, x: firstPoint[0], y: firstPoint[1]});
            firstVertexId = currentVertexId;
        }
        for (var pieceIndex = 1; pieceIndex < flattened.length; pieceIndex += 1) {
            var closesPath = item.closed && pointIndex === segmentCount - 1 && pieceIndex === flattened.length - 1;
            var nextVertexId = closesPath ? firstVertexId : "v-" + pathIndex + "-" + vertexIndex;
            if (!closesPath) {
                vertexIndex += 1;
                var converted = structurePoint(flattened[pieceIndex], artboardLeft, artboardTop);
                localVertices.push({id: nextVertexId, x: converted[0], y: converted[1]});
            }
            localEdges.push({
                id: "e-" + pathIndex + "-" + pointIndex + "-" + (pieceIndex - 1),
                start: currentVertexId,
                end: nextVertexId,
                assignment: assignment,
                source_refs: ["path:" + pathIndex + "/segment:" + pointIndex]
            });
            currentVertexId = nextVertexId;
        }
        previousVertexId = currentVertexId;
    }
    if (structure.edges.length + localEdges.length > 20000) {
        uniquePush(errors, "structure_limit_exceeded");
        return 0;
    }
    for (pointIndex = 0; pointIndex < localVertices.length; pointIndex += 1) {
        structure.vertices.push(localVertices[pointIndex]);
    }
    for (pointIndex = 0; pointIndex < localEdges.length; pointIndex += 1) {
        structure.edges.push(localEdges[pointIndex]);
    }
    structure.source.geometry.generated_line_segments += localEdges.length;
    structure.source.geometry.curved_source_segments += localRepairs.length;
    for (pointIndex = 0; pointIndex < localRepairs.length && structure.source.geometry.repairs.length < 100; pointIndex += 1) {
        structure.source.geometry.repairs.push(localRepairs[pointIndex]);
    }
    if (localRepairs.length > 0) {
        uniquePush(structure.validation.warnings, "structure_curve_flattened");
        if (structure.source.geometry.repairs.length < structure.source.geometry.curved_source_segments) {
            uniquePush(structure.validation.warnings, "structure_repair_ledger_truncated");
        }
    }
    return localEdges.length;
}

function findLockState(states, target) {
    for (var index = 0; index < states.length; index += 1) {
        if (states[index].target === target) {
            return index;
        }
    }
    return -1;
}

function semanticNodeType(target) {
    try {
        return String(target.typename);
    } catch (error) {
        return "Unknown";
    }
}

function isSemanticLockableType(typeName) {
    return typeName === "Layer" ||
        typeName === "GroupItem" ||
        typeName === "CompoundPathItem" ||
        typeName === "PathItem" ||
        typeName === "SymbolItem" ||
        typeName === "PlacedItem" ||
        typeName === "RasterItem" ||
        typeName === "TextFrame" ||
        typeName === "MeshItem" ||
        typeName === "PluginItem" ||
        typeName === "GraphItem" ||
        typeName === "LegacyTextItem";
}

function findSemanticAncestor(chain, target) {
    for (var index = 0; index < chain.length; index += 1) {
        if (chain[index] === target) {
            return index;
        }
    }
    return -1;
}

function readSemanticParent(target, issues) {
    try {
        return target.parent;
    } catch (parentError) {
        // Some compound paths and symbols proxy parent through a host object.
        // Their layer is still a safe ancestor and lets the outer lock restore.
        try {
            var layer = target.layer;
            if (layer !== target) {
                issues.push("ancestor_parent_via_layer:" + semanticNodeType(target));
                return layer;
            }
        } catch (layerError) {
            // Report below after both host properties have been attempted.
        }
        issues.push("ancestor_parent_unreadable:" + semanticNodeType(target));
        return null;
    }
}

function setSemanticLocked(target, value) {
    var setterError = null;
    try {
        target.locked = value;
    } catch (error) {
        setterError = error;
    }
    try {
        // Illustrator host setters can mutate successfully and then throw.
        // Verify the observable state before deciding whether rollback failed.
        if (Boolean(target.locked) === Boolean(value)) {
            return null;
        }
    } catch (verificationError) {
        if (setterError !== null) {
            return setterError.message + " | lock verification failed: " + verificationError.message;
        }
        return "lock verification failed: " + verificationError.message;
    }
    if (setterError !== null) {
        return setterError.message;
    }
    return "locked state did not change";
}

function unlockSemanticAncestors(item, lockStates, issues) {
    var chain = [];
    var current = item;
    var depth = 0;
    while (current !== null && current !== undefined && depth < 256) {
        var typeName = semanticNodeType(current);
        if (typeName === "Document") {
            break;
        }
        if (findSemanticAncestor(chain, current) >= 0) {
            issues.push("ancestor_cycle:" + typeName);
            break;
        }
        chain.push(current);
        current = readSemanticParent(current, issues);
        depth += 1;
    }
    if (depth >= 256) {
        issues.push("ancestor_depth_exceeded");
    }
    for (var index = chain.length - 1; index >= 0; index -= 1) {
        var target = chain[index];
        if (findLockState(lockStates, target) >= 0) {
            continue;
        }
        var targetType = semanticNodeType(target);
        if (!isSemanticLockableType(targetType)) {
            issues.push("ancestor_lock_unsupported:" + targetType);
            continue;
        }
        var locked = false;
        try {
            locked = Boolean(target.locked);
        } catch (error) {
            // One unsupported host node must not block the rest of the chain.
            issues.push("ancestor_lock_unreadable:" + targetType);
            continue;
        }
        if (locked) {
            // Record the original state before touching the host object.  Some
            // Illustrator proxy setters change state and then throw.
            lockStates.push({target: target, locked: true, typeName: targetType});
            var unlockFailure = setSemanticLocked(target, false);
            if (unlockFailure !== null) {
                issues.push("ancestor_unlock_failed:" + targetType);
                throw new Error("Cannot unlock semantic ancestor " + targetType + ": " + unlockFailure);
            }
        }
    }
}

function hideSemanticItems(items) {
    var state = {items: [], locks: [], issues: []};
    for (var index = 0; index < items.length; index += 1) {
        var item = items[index];
        try {
            state.items.push({item: item, hidden: item.hidden});
            unlockSemanticAncestors(item, state.locks, state.issues);
            item.hidden = true;
        } catch (error) {
            var restoreFailure = null;
            try {
                restoreSemanticItems(state);
            } catch (restoreError) {
                restoreFailure = restoreError.message;
            }
            var hideMessage = "Cannot hide semantic object path:" + index + " " + error.message;
            if (restoreFailure !== null) {
                hideMessage += " | " + restoreFailure;
            }
            throw new Error(hideMessage);
        }
    }
    return state;
}

function restoreSemanticItems(state) {
    if (state === null || state === undefined) {
        return;
    }
    var failures = [];
    for (var itemIndex = state.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        try {
            state.items[itemIndex].item.hidden = state.items[itemIndex].hidden;
        } catch (itemError) {
            failures.push("hidden:" + itemIndex + ":" + itemError.message);
        }
    }
    for (var lockIndex = state.locks.length - 1; lockIndex >= 0; lockIndex -= 1) {
        var lockFailure = setSemanticLocked(
            state.locks[lockIndex].target,
            state.locks[lockIndex].locked
        );
        if (lockFailure !== null) {
            failures.push("locked:" + state.locks[lockIndex].typeName + ":" + lockFailure);
        }
    }
    if (failures.length > 0) {
        throw new Error("Cannot fully restore semantic objects: " + failures.join(" | "));
    }
}

function withHiddenSemanticItems(items, callback) {
    var state = hideSemanticItems(items);
    var callbackError = null;
    try {
        callback();
    } catch (error) {
        callbackError = error;
    }
    var restoreError = null;
    try {
        restoreSemanticItems(state);
    } catch (error) {
        restoreError = error;
    }
    if (callbackError !== null && restoreError !== null) {
        throw new Error(callbackError.message + " | " + restoreError.message);
    }
    if (callbackError !== null) {
        throw callbackError;
    }
    if (restoreError !== null) {
        throw restoreError;
    }
}

function normalizedPrintLayerNames(values) {
    if (!(values instanceof Array)) {
        throw new Error("print_layers must be an array");
    }
    var names = [];
    for (var index = 0; index < values.length; index += 1) {
        var name = String(values[index] || "");
        if (name.length < 1) {
            continue;
        }
        var duplicate = false;
        for (var prior = 0; prior < names.length; prior += 1) {
            if (names[prior] === name) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) {
            names.push(name);
        }
    }
    if (names.length < 1) {
        throw new Error("print_layers must name at least one explicit artwork layer");
    }
    return names;
}

function containsExactLayerName(names, name) {
    for (var index = 0; index < names.length; index += 1) {
        if (names[index] === name) {
            return true;
        }
    }
    return false;
}

function restorePrintLayers(state) {
    var failures = [];
    for (var index = state.length - 1; index >= 0; index -= 1) {
        try {
            state[index].layer.visible = state[index].visible;
            if (Boolean(state[index].layer.visible) !== state[index].visible) {
                throw new Error("visibility did not change");
            }
        } catch (error) {
            failures.push(state[index].name + ":" + error.message);
        }
    }
    if (failures.length > 0) {
        throw new Error("Cannot fully restore artwork layers: " + failures.join(" | "));
    }
}

function isolateConfiguredPrintLayers(documentRef, configuredNames) {
    var names = normalizedPrintLayerNames(configuredNames);
    var state = [];
    var found = [];
    var failure = null;
    try {
        for (var index = 0; index < documentRef.layers.length; index += 1) {
            var layer = documentRef.layers[index];
            var layerName = String(layer.name || "");
            var visible = Boolean(layer.visible);
            state.push({layer: layer, name: layerName, visible: visible});
            var shouldShow = containsExactLayerName(names, layerName);
            layer.visible = shouldShow;
            if (Boolean(layer.visible) !== shouldShow) {
                throw new Error("Cannot set artwork layer visibility: " + layerName);
            }
            if (shouldShow) {
                found.push(layerName);
            }
        }
        for (var nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
            if (!containsExactLayerName(found, names[nameIndex])) {
                throw new Error("Configured artwork layer not found: " + names[nameIndex]);
            }
        }
    } catch (error) {
        failure = error;
    }
    if (failure !== null) {
        var restoreError = null;
        try {
            restorePrintLayers(state);
        } catch (error) {
            restoreError = error;
        }
        if (restoreError !== null) {
            throw new Error(failure.message + " | " + restoreError.message);
        }
        throw failure;
    }
    return state;
}

function withConfiguredPrintLayers(documentRef, configuredNames, callback) {
    var state = isolateConfiguredPrintLayers(documentRef, configuredNames);
    var callbackError = null;
    try {
        callback();
    } catch (error) {
        callbackError = error;
    }
    var restoreError = null;
    try {
        restorePrintLayers(state);
    } catch (error) {
        restoreError = error;
    }
    if (callbackError !== null && restoreError !== null) {
        throw new Error(callbackError.message + " | " + restoreError.message);
    }
    if (callbackError !== null) {
        throw callbackError;
    }
    if (restoreError !== null) {
        throw restoreError;
    }
}

var configPath = PIPELINE_CONFIG_PATH;
var config = eval("(" + readUtf8(configPath) + ")");
var debugPath = config.debug_log;
var previousInteractionLevel = app.userInteractionLevel;
var documentRef = null;
var result = {
    success: false,
    source_ai: config.source_ai,
    full_pdf: config.full_pdf,
    print_pdf: config.print_pdf,
    structure_json: config.structure_json,
    layers: [],
    proposal_layer_candidates: [],
    proposal_layer_candidates_truncated: false,
    preview_plate_candidates: [],
    preview_plate_candidates_truncated: false,
    page_size_points: [],
    semantic_path_count: 0,
    semantic_edge_count: 0,
    illustrator_version: app.version
};

try {
    if (!config.source_sha256 || String(config.source_sha256).length !== 64) {
        throw new Error("source_sha256 is required for semantic export");
    }
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
    appendUtf8(debugPath, "v2 01 opening source");
    if (config.document_already_open) {
        if (app.documents.length < 1) {
            throw new Error("Expected an externally opened document");
        }
        documentRef = app.activeDocument;
    } else {
        documentRef = app.open(new File(config.source_ai));
    }
    if (documentRef.artboards.length < 1) {
        throw new Error("Document has no artboard");
    }
    var artboard = documentRef.artboards[0].artboardRect;
    result.page_size_points = [
        Math.abs(artboard[2] - artboard[0]),
        Math.abs(artboard[1] - artboard[3])
    ];
    for (var layerIndex = 0; layerIndex < documentRef.layers.length; layerIndex += 1) {
        result.layers.push(documentRef.layers[layerIndex].name);
    }

    var structure = {
        schema: "packaging-structure/1",
        units: "pt",
        source: {
            sha256: String(config.source_sha256).toLowerCase(),
            adapter: "illustrator-semantic/1",
            adapter_version: "1.1.0",
            document_ref: String(config.source_ai),
            coordinate_space: "artboard-top-left",
            page_size: result.page_size_points,
            geometry: {
                coordinate_frame: "artboard-top-left",
                precision: 0.001,
                curve_tolerance: 0.25,
                curved_source_segments: 0,
                generated_line_segments: 0,
                repairs: []
            }
        },
        vertices: [],
        edges: [],
        faces: [],
        folds: [],
        root_face: null,
        validation: {status: "review_required", errors: [], warnings: []}
    };
    var semanticItems = [];
    var explicitRecords = [];
    var proposalRecords = [];
    var proposalLayerKeys = [];
    var previewPlateKeys = [];
    var proposalPreviewBudget = {paths: 0, points: 0};
    for (var pathIndex = 0; pathIndex < documentRef.pathItems.length; pathIndex += 1) {
        var item = documentRef.pathItems[pathIndex];
        if (item.clipping) {
            continue;
        }
        var assignment = assignmentOf(item, config);
        if (assignment !== null) {
            explicitRecords.push({item: item, pathIndex: pathIndex, assignment: assignment});
        } else if (configuredProposalLayer(item, config)) {
            proposalRecords.push({item: item, pathIndex: pathIndex, assignment: "crease"});
        } else if (recordProposalLayerCandidate(
            result.proposal_layer_candidates,
            proposalLayerKeys,
            item,
            artboard[0],
            artboard[1],
            proposalPreviewBudget
        )) {
            result.proposal_layer_candidates_truncated = true;
        } else if (recordPreviewPlateCandidate(
            result.preview_plate_candidates,
            previewPlateKeys,
            proposalLayerKeys,
            item,
            artboard[0],
            artboard[1],
            proposalPreviewBudget
        )) {
            result.preview_plate_candidates_truncated = true;
        }
    }
    if (explicitRecords.length > 0) {
        // Exact object semantics always win as one indivisible structure input.
        // Do not offer a layer fallback that this export deliberately ignored.
        result.proposal_layer_candidates = [];
        result.proposal_layer_candidates_truncated = false;
        result.preview_plate_candidates = [];
        result.preview_plate_candidates_truncated = false;
    }
    var chosenRecords = explicitRecords.length > 0 ? explicitRecords : proposalRecords;
    var proposalMode = explicitRecords.length === 0 && proposalRecords.length > 0;
    if (proposalMode) {
        structure.source.adapter = "illustrator-stroke-proposal/1";
        structure.source.adapter_version = "1.1.0";
        uniquePush(structure.validation.errors, "structure_proposal_requires_confirmation");
    }
    if (chosenRecords.length > 5000) {
        uniquePush(structure.validation.errors, "structure_limit_exceeded");
    }
    for (var recordIndex = 0; recordIndex < chosenRecords.length && !hasFatalStructureError(structure.validation.errors); recordIndex += 1) {
        var record = chosenRecords[recordIndex];
        semanticItems.push(record.item);
        result.semantic_path_count += 1;
        if (record.assignment === "ignore") {
            continue;
        }
        result.semantic_edge_count += exportSemanticPath(
            record.item,
            record.pathIndex,
            record.assignment,
            structure,
            structure.validation.errors,
            artboard[0],
            artboard[1]
        );
    }
    result.proposal_mode = proposalMode;
    result.proposal_path_count = proposalRecords.length;
    if (result.semantic_edge_count === 0) {
        uniquePush(structure.validation.errors, "structure_semantics_missing");
    }
    uniquePush(structure.validation.errors, "structure_face_mapping_incomplete");

    appendUtf8(debugPath, "v2 02 saving full pdf");
    savePdf(documentRef, config.full_pdf);
    withHiddenSemanticItems(semanticItems, function () {
        withConfiguredPrintLayers(documentRef, config.print_layers, function () {
            appendUtf8(debugPath, "v2 03 saving isolated artwork pdf");
            savePdf(documentRef, config.print_pdf);
        });
    });
    writeUtf8(config.structure_json, jsonStringify(structure));
    result.semantic_errors = structure.validation.errors;
    result.success = true;
} catch (error) {
    appendUtf8(debugPath, "V2 ERROR " + error.message);
    result.error = error.message;
    result.error_line = error.line || null;
} finally {
    if (documentRef !== null) {
        try {
            documentRef.close(SaveOptions.DONOTSAVECHANGES);
        } catch (closeError) {
            result.close_error = closeError.message;
        }
    }
    app.userInteractionLevel = previousInteractionLevel;
    writeUtf8(config.result_json, jsonStringify(result));
}

jsonStringify(result);
