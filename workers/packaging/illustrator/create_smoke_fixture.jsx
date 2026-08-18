function readUtf8(pathValue) {
    var file = new File(pathValue);
    file.encoding = "UTF-8";
    file.open("r");
    var text = file.read();
    file.close();
    return text;
}

var config = eval("(" + readUtf8(PIPELINE_CONFIG_PATH) + ")");
var previousInteractionLevel = app.userInteractionLevel;
var documentRef = null;
try {
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
    documentRef = app.documents.add(
        DocumentColorSpace.CMYK,
        config.width_points,
        config.height_points
    );
    var printLayer = documentRef.layers[0];
    printLayer.name = "印刷";

    var background = printLayer.pathItems.rectangle(
        0,
        0,
        config.width_points,
        config.height_points
    );
    var backgroundColor = new CMYKColor();
    backgroundColor.cyan = 8;
    backgroundColor.magenta = 3;
    backgroundColor.yellow = 0;
    backgroundColor.black = 5;
    background.fillColor = backgroundColor;
    background.stroked = false;

    var title = printLayer.textFrames.pointText([700, -550]);
    title.contents = "ILLUSTRATOR FALLBACK TEST";
    title.textRange.characterAttributes.size = 42;

    var options = new IllustratorSaveOptions();
    options.pdfCompatible = false;
    options.compressed = true;
    var output = new File(config.output_ai);
    if (output.exists) {
        output.remove();
    }
    documentRef.saveAs(output, options);
} finally {
    if (documentRef !== null) {
        documentRef.close(SaveOptions.DONOTSAVECHANGES);
    }
    app.userInteractionLevel = previousInteractionLevel;
}

config.output_ai;
