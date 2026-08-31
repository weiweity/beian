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

function unlockSemanticAncestors(item, lockStates) {
    var chain = [];
    var current = item;
    while (current !== null && current !== undefined && current.typename !== "Document") {
        chain.push(current);
        current = current.parent;
    }
    for (var index = chain.length - 1; index >= 0; index -= 1) {
        var target = chain[index];
        if (findLockState(lockStates, target) >= 0) {
            continue;
        }
        try {
            var locked = target.locked;
            lockStates.push({target: target, locked: locked});
            if (locked) {
                target.locked = false;
            }
        } catch (error) {
            // Some Illustrator collection parents do not expose a lock state.
        }
    }
}

function hideSemanticItems(items) {
    var state = {items: [], locks: []};
    for (var index = 0; index < items.length; index += 1) {
        var item = items[index];
        try {
            state.items.push({item: item, hidden: item.hidden});
            unlockSemanticAncestors(item, state.locks);
            item.hidden = true;
        } catch (error) {
            restoreSemanticItems(state);
            throw new Error("Cannot hide semantic object path:" + index + " " + error.message);
        }
    }
    return state;
}

function restoreSemanticItems(state) {
    if (state === null || state === undefined) {
        return;
    }
    for (var itemIndex = state.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        try {
            state.items[itemIndex].item.hidden = state.items[itemIndex].hidden;
        } catch (itemError) {
            // The document is closed without saving; restoration is best effort.
        }
    }
    for (var lockIndex = state.locks.length - 1; lockIndex >= 0; lockIndex -= 1) {
        try {
            state.locks[lockIndex].target.locked = state.locks[lockIndex].locked;
        } catch (lockError) {
            // The document is closed without saving; restoration is best effort.
        }
    }
}

function withHiddenSemanticItems(items, callback) {
    var state = hideSemanticItems(items);
    try {
        callback();
    } finally {
        restoreSemanticItems(state);
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
        }
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
        appendUtf8(debugPath, "v2 03 saving object-clean artwork pdf");
        savePdf(documentRef, config.print_pdf);
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
