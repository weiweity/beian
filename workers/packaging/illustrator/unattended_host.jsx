function isoUtcNow() {
    var now = new Date();
    function pad(value) {
        return (value < 10 ? "0" : "") + value;
    }
    return (
        now.getUTCFullYear() +
        "-" +
        pad(now.getUTCMonth() + 1) +
        "-" +
        pad(now.getUTCDate()) +
        "T" +
        pad(now.getUTCHours()) +
        ":" +
        pad(now.getUTCMinutes()) +
        ":" +
        pad(now.getUTCSeconds()) +
        "Z"
    );
}

function jsonEscapeHost(value) {
    return String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t");
}

function writeUtf8(pathValue, text) {
    var dest = new File(pathValue);
    var tmp = new File(pathValue + ".tmp");
    if (tmp.exists) {
        tmp.remove();
    }
    tmp.encoding = "UTF-8";
    if (!tmp.open("w")) {
        throw new Error("Cannot write result: " + pathValue);
    }
    tmp.write(text);
    tmp.close();
    if (dest.exists) {
        dest.remove();
    }
    if (!tmp.rename(dest.name)) {
        throw new Error("Cannot replace result: " + pathValue);
    }
}

function jobProgressPath(config) {
    var debugFile = new File(config.debug_log);
    return debugFile.parent.fsName + "/illustrator_progress.json";
}

function writeJobProgress(config, stage) {
    if (!config || !config.debug_log) {
        return;
    }
    var payload =
        '{"schema":"illustrator-job-progress/1","attempt_id":"' +
        jsonEscapeHost(config.attempt_id || "") +
        '","stage":"' +
        jsonEscapeHost(stage) +
        '","updated_at":"' +
        isoUtcNow() +
        '","source_sha256":"' +
        jsonEscapeHost(config.source_sha256 || "") +
        '"}';
    writeUtf8(jobProgressPath(config), payload);
}

function captureTopLayerVisibility(documentRef) {
    var captured = [];
    if (!documentRef || !documentRef.layers) {
        return captured;
    }
    var count = documentRef.layers.length;
    var index;
    for (index = 0; index < count; index += 1) {
        var layer = documentRef.layers[index];
        var visible = true;
        try {
            visible = Boolean(layer.visible);
        } catch (readError) {
            visible = true;
        }
        captured.push({layer: layer, visible: visible});
    }
    return captured;
}

function applyCapturedLayerVisibility(captured, visibleOverride) {
    if (!captured || !captured.length) {
        return;
    }
    var index;
    for (index = 0; index < captured.length; index += 1) {
        try {
            var nextVisible = visibleOverride === null || typeof visibleOverride === "undefined"
                ? captured[index].visible
                : Boolean(visibleOverride);
            captured[index].layer.visible = nextVisible;
        } catch (writeError) {
            /* locked / hidden-by-template layers must not fail-closed */
        }
    }
}

function viewModeOf(documentRef) {
    try {
        if (documentRef && typeof documentRef.getViewMode === "function") {
            return String(documentRef.getViewMode() || "");
        }
    } catch (modeError) {
        return "";
    }
    return "";
}

function viewLooksLikeOutline(mode) {
    var text = String(mode || "").toLowerCase();
    return text.indexOf("outline") >= 0 || text.indexOf("轮廓") >= 0;
}

function enterOutlineView(documentRef) {
    var before = viewModeOf(documentRef);
    if (viewLooksLikeOutline(before)) {
        return {ok: true, via: "already", mode: before};
    }
    try {
        // View > Outline/Preview is "preview". "outline" is Type > Create Outlines.
        // One press only: a second press toggles back to GPU/CPU preview.
        app.executeMenuCommand("preview");
    } catch (previewError) {
        /* Chinese UI / missing command: hide-layers + zoom still reduce redraw */
    }
    var mode = viewModeOf(documentRef);
    if (viewLooksLikeOutline(mode)) {
        return {ok: true, via: "preview", mode: mode};
    }
    return {ok: false, via: "preview", mode: mode || before};
}

function setUnattendedZoom(documentRef, zoom) {
    try {
        if (documentRef && documentRef.views && documentRef.views.length > 0) {
            documentRef.views[0].zoom = zoom;
        }
    } catch (zoomError) {
        /* zoom is best-effort */
    }
}

function applyUnattendedHost(documentRef) {
    var state = {
        liveEdit: null,
        restored: false,
        layers: [],
        zoom: null,
        outline: false,
        viewMode: ""
    };
    try {
        state.liveEdit = app.preferences.getBooleanPreference("LiveEdit_State_Machine");
    } catch (readError) {
        state.liveEdit = null;
    }
    try {
        app.preferences.setBooleanPreference("LiveEdit_State_Machine", false);
    } catch (writeError) {
        /* keep going; unattended host must not fail-closed */
    }
    try {
        if (documentRef && documentRef.views && documentRef.views.length > 0) {
            state.zoom = documentRef.views[0].zoom;
        }
    } catch (zoomReadError) {
        state.zoom = null;
    }
    state.layers = captureTopLayerVisibility(documentRef);
    applyCapturedLayerVisibility(state.layers, false);
    var outline = enterOutlineView(documentRef);
    state.outline = outline.ok;
    state.viewMode = outline.mode;
    var UNATTENDED_INVENTORY_ZOOM = 0.0625;
    setUnattendedZoom(documentRef, UNATTENDED_INVENTORY_ZOOM);
    return state;
}

function restoreUnattendedArtwork(documentRef, state) {
    if (!state) {
        return;
    }
    applyCapturedLayerVisibility(state.layers, null);
    if (state.layers && state.layers.length) {
        var expected = 0;
        var visible = 0;
        var index;
        for (index = 0; index < state.layers.length; index += 1) {
            if (!state.layers[index].visible) {
                continue;
            }
            expected += 1;
            try {
                if (Boolean(state.layers[index].layer.visible)) {
                    visible += 1;
                }
            } catch (readError) {
                /* count as still hidden */
            }
        }
        if (expected > 0 && visible < expected) {
            throw new Error("Cannot fully restore artwork layers");
        }
    }
    if (state.zoom !== null && typeof state.zoom !== "undefined") {
        setUnattendedZoom(documentRef, state.zoom);
    }
}

function prepareUnattendedClose(documentRef, state) {
    var layers = state && state.layers && state.layers.length
        ? state.layers
        : captureTopLayerVisibility(documentRef);
    applyCapturedLayerVisibility(layers, false);
    enterOutlineView(documentRef);
    var UNATTENDED_CLOSE_ZOOM = 0.03125;
    setUnattendedZoom(documentRef, UNATTENDED_CLOSE_ZOOM);
}

function restoreUnattendedHost(state) {
    if (!state || state.restored) {
        return;
    }
    state.restored = true;
    if (state.liveEdit === null) {
        return;
    }
    app.preferences.setBooleanPreference("LiveEdit_State_Machine", state.liveEdit);
}
