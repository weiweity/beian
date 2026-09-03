#include "unattended_host.jsx"

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

function appendUtf8(pathValue, text) {
    var file = new File(pathValue);
    file.encoding = "UTF-8";
    if (!file.open("a")) {
        return;
    }
    file.writeln(text);
    file.close();
}

function contains(values, candidate) {
    for (var index = 0; index < values.length; index += 1) {
        if (values[index] === candidate) {
            return true;
        }
    }
    return false;
}

function jsonEscape(value) {
    return value
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

var configPath = PIPELINE_CONFIG_PATH;
var config = eval("(" + readUtf8(configPath) + ")");
var debugPath = config.debug_log;
appendUtf8(debugPath, "01 config parsed");
var previousInteractionLevel = app.userInteractionLevel;
var documentRef = null;
var result = {
    success: false,
    source_ai: config.source_ai,
    full_pdf: config.full_pdf,
    print_pdf: config.print_pdf,
    layers: [],
    page_size_points: [],
    illustrator_version: app.version,
    attempt_id: config.attempt_id || ""
};
var hostState = { liveEdit: null, restored: true };
var resultCommitted = false;

function commitResult() {
    writeUtf8(config.result_json, jsonStringify(result));
    resultCommitted = true;
}

try {
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
    writeJobProgress(config, "opening");
    appendUtf8(debugPath, "02 opening source");
    if (config.document_already_open) {
        if (app.documents.length < 1) {
            throw new Error("Expected an externally opened document");
        }
        documentRef = app.activeDocument;
    } else {
        documentRef = app.open(new File(config.source_ai));
    }
    hostState = applyUnattendedHost(documentRef);
    appendUtf8(
        debugPath,
        "host outline_ok=" + (hostState.outline ? "1" : "0") +
            " view=" + String(hostState.viewMode || "")
    );
    writeJobProgress(config, "inventory");
    appendUtf8(debugPath, "03 source opened");
    if (documentRef.artboards.length < 1) {
        throw new Error("Document has no artboard");
    }
    var artboard = documentRef.artboards[0].artboardRect;
    result.page_size_points = [
        Math.abs(artboard[2] - artboard[0]),
        Math.abs(artboard[1] - artboard[3])
    ];

    var visibility = [];
    var layerIndex;
    for (layerIndex = 0; layerIndex < documentRef.layers.length; layerIndex += 1) {
        result.layers.push(documentRef.layers[layerIndex].name);
        visibility.push(documentRef.layers[layerIndex].visible);
    }

    restoreUnattendedArtwork(documentRef, hostState);
    writeJobProgress(config, "saving_full_pdf");
    appendUtf8(debugPath, "04 saving full pdf");
    savePdf(documentRef, config.full_pdf);
    appendUtf8(debugPath, "05 full pdf saved");

    for (layerIndex = 0; layerIndex < documentRef.layers.length; layerIndex += 1) {
        documentRef.layers[layerIndex].visible = contains(
            config.print_layers,
            documentRef.layers[layerIndex].name
        );
    }
    appendUtf8(debugPath, "06 print layers selected");
    writeJobProgress(config, "saving_artwork_pdf");
    appendUtf8(debugPath, "07 saving print pdf");
    savePdf(documentRef, config.print_pdf);
    appendUtf8(debugPath, "08 print pdf saved");

    result.success = true;
    writeJobProgress(config, "writing_result");
    commitResult();
} catch (error) {
    appendUtf8(debugPath, "ERROR " + error.message);
    result.error = error.message;
    result.error_line = error.line || null;
    try {
        commitResult();
    } catch (resultError) {
        appendUtf8(debugPath, "ERROR result " + resultError.message);
    }
} finally {
    writeJobProgress(config, "closing");
    appendUtf8(debugPath, "09 closing document");
    if (documentRef !== null) {
        try {
            prepareUnattendedClose(documentRef, hostState);
        } catch (closePrepError) {
            result.close_prep_error = closePrepError.message;
        }
        try {
            documentRef.close(SaveOptions.DONOTSAVECHANGES);
        } catch (closeError) {
            result.close_error = closeError.message;
        }
    }
    try {
        restoreUnattendedHost(hostState);
    } catch (hostRestoreError) {
        result.host_restore_error = hostRestoreError.message;
    }
    app.userInteractionLevel = previousInteractionLevel;
    if (!resultCommitted || result.close_error || result.close_prep_error || result.host_restore_error) {
        try {
            commitResult();
        } catch (finalResultError) {
            appendUtf8(debugPath, "ERROR final result " + finalResultError.message);
        }
    }
    appendUtf8(debugPath, "10 result written");
}

jsonStringify(result);
