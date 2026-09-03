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

function applyUnattendedHost(documentRef) {
    var state = { liveEdit: null, restored: false };
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
        // View > Outline is "preview" in Illustrator. "outline" is Type > Create Outlines.
        app.executeMenuCommand("preview");
    } catch (previewError) {
        /* Chinese UI / missing command: inventory still reads objects */
    }
    return state;
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
