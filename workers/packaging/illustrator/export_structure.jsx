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

function exportSemanticPath(item, pathIndex, assignment, structure, errors, artboardLeft, artboardTop) {
    var points = item.pathPoints;
    if (!points || points.length < 2) {
        uniquePush(errors, "structure_path_too_short");
        return 0;
    }
    var pointIndex;
    for (pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
        structure.vertices.push({
            id: "v-" + pathIndex + "-" + pointIndex,
            x: points[pointIndex].anchor[0] - artboardLeft,
            y: artboardTop - points[pointIndex].anchor[1]
        });
    }
    var segmentCount = item.closed ? points.length : points.length - 1;
    var exported = 0;
    for (pointIndex = 0; pointIndex < segmentCount; pointIndex += 1) {
        var nextIndex = (pointIndex + 1) % points.length;
        if (hasCurve(points[pointIndex], points[nextIndex])) {
            uniquePush(errors, "structure_curve_requires_adapter");
            continue;
        }
        structure.edges.push({
            id: "e-" + pathIndex + "-" + pointIndex,
            start: "v-" + pathIndex + "-" + pointIndex,
            end: "v-" + pathIndex + "-" + nextIndex,
            assignment: assignment,
            source_refs: ["path:" + pathIndex + "/segment:" + pointIndex]
        });
        exported += 1;
    }
    return exported;
}

function hideSemanticItems(items) {
    var states = [];
    for (var index = 0; index < items.length; index += 1) {
        var item = items[index];
        states.push({item: item, hidden: item.hidden, locked: item.locked});
        try {
            item.locked = false;
            item.hidden = true;
        } catch (error) {
            throw new Error("Cannot hide semantic object path:" + index + " " + error.message);
        }
    }
    return states;
}

function restoreSemanticItems(states) {
    for (var index = states.length - 1; index >= 0; index -= 1) {
        try {
            states[index].item.hidden = states[index].hidden;
            states[index].item.locked = states[index].locked;
        } catch (error) {
            // The document is closed without saving; restoration is best effort.
        }
    }
}

var configPath = PIPELINE_CONFIG_PATH;
var config = eval("(" + readUtf8(configPath) + ")");
var debugPath = config.debug_log;
var previousInteractionLevel = app.userInteractionLevel;
var documentRef = null;
var semanticStates = [];
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
            adapter_version: "1.0.0",
            document_ref: String(config.source_ai),
            coordinate_space: "artboard-top-left",
            page_size: result.page_size_points
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
        structure.source.adapter_version = "1.0.0";
        uniquePush(structure.validation.errors, "structure_proposal_requires_confirmation");
    }
    for (var recordIndex = 0; recordIndex < chosenRecords.length; recordIndex += 1) {
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
    semanticStates = hideSemanticItems(semanticItems);
    appendUtf8(debugPath, "v2 03 saving object-clean artwork pdf");
    savePdf(documentRef, config.print_pdf);
    restoreSemanticItems(semanticStates);
    semanticStates = [];
    writeUtf8(config.structure_json, jsonStringify(structure));
    result.semantic_errors = structure.validation.errors;
    result.success = true;
} catch (error) {
    appendUtf8(debugPath, "V2 ERROR " + error.message);
    result.error = error.message;
    result.error_line = error.line || null;
} finally {
    restoreSemanticItems(semanticStates);
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
