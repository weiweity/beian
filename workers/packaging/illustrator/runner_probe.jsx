if ("刀版".charCodeAt(0) !== 0x5200 || "刀版".charCodeAt(1) !== 0x7248) {
  throw new Error("encoding");
}
if ("刀线".charCodeAt(0) !== 0x5200 || "刀线".charCodeAt(1) !== 0x7EBF) {
  throw new Error("encoding");
}
var probeFile = new File(PIPELINE_CONFIG_PATH);
probeFile.open("w");
probeFile.write("runner-ok");
probeFile.close();
"runner-ok";
