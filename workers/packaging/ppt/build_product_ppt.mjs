import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("usage: node build_product_ppt.mjs ppt_job.json");

function addText(slide, name, text, position, style = {}) {
  const box = slide.shapes.add({
    geometry: "textbox",
    name,
    position,
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  box.text = text;
  box.text.style = {
    typeface: "PingFang SC",
    color: "#111111",
    verticalAlignment: "top",
    autoFit: "none",
    wrap: "square",
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...style,
  };
  return box;
}

function addRule(slide, name, left, top, width, color = "#A88265") {
  slide.shapes.add({
    geometry: "rect",
    name,
    position: { left, top, width, height: 5 },
    fill: color,
    line: { style: "solid", fill: color, width: 0 },
  });
}

function addImage(slide, name, bytes, alt, position) {
  return slide.images.add({
    blob: bytes,
    contentType: "image/png",
    alt,
    fit: "contain",
    position,
  });
}

function sourceNotes(input, imagePath, label) {
  return [
    "[Sources]",
    "- " + label + "：" + imagePath,
    "- 原始包装稿：" + input.source_ai,
    "[/Sources]",
  ].join("\n");
}

async function main() {
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  await fs.mkdir(path.dirname(input.pptx_path), { recursive: true });
  await fs.mkdir(input.qa_dir, { recursive: true });
  const [frontBytes, backBytes] = await Promise.all([
    fs.readFile(input.outputs.front_right),
    fs.readFile(input.outputs.back_left),
  ]);

  const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  const title = String(input.display_name || "");
  const dim = input.dimensions_mm;

  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  addText(slide, "product-title", title, { left: 48, top: 24, width: 1184, height: 40 }, {
    fontSize: 28,
    bold: true,
  });
  addText(slide, "deck-meta", input.code + "  ·  " + dim.width + " × " + dim.depth + " × " + dim.height + " mm", {
    left: 48,
    top: 68,
    width: 900,
    height: 28,
  }, {
    fontSize: 16,
    color: "#777C84",
  });
  addRule(slide, "accent-rule", 48, 100, 128);
  addImage(
    slide,
    "front-right-render",
    frontBytes,
    input.display_name + "包装正面与右侧白底3D渲染",
    { left: 36, top: 120, width: 590, height: 540 },
  );
  addImage(
    slide,
    "back-left-render",
    backBytes,
    input.display_name + "包装背面与左侧白底3D渲染",
    { left: 654, top: 120, width: 590, height: 540 },
  );
  addText(slide, "front-caption", "正面 + 侧面", { left: 36, top: 668, width: 590, height: 28 }, {
    fontSize: 16,
    color: "#585D66",
    alignment: "center",
  });
  addText(slide, "back-caption", "反面 + 侧面", { left: 654, top: 668, width: 590, height: 28 }, {
    fontSize: 16,
    color: "#585D66",
    alignment: "center",
  });
  slide.speakerNotes.textFrame.setText(
    sourceNotes(input, input.outputs.front_right, "正面与右侧3D图") +
      "\n" +
      sourceNotes(input, input.outputs.back_left, "背面与左侧3D图"),
  );

  for (const [index, slide] of presentation.slides.items.entries()) {
    const stem = "slide-" + String(index + 1).padStart(2, "0");
    const png = await presentation.export({ slide, format: "png", scale: 1 });
    await fs.writeFile(path.join(input.qa_dir, stem + ".png"), new Uint8Array(await png.arrayBuffer()));
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(path.join(input.qa_dir, stem + ".layout.json"), await layout.text());
  }
  const montage = await presentation.export({ format: "webp", montage: true, scale: 1 });
  await fs.writeFile(path.join(input.qa_dir, "montage.webp"), new Uint8Array(await montage.arrayBuffer()));
  const inspection = await presentation.inspect({
    kind: "slide,textbox,shape,image,notes",
    maxChars: 20000,
  });
  await fs.writeFile(path.join(input.qa_dir, "inspection.ndjson"), inspection.ndjson);
  await fs.writeFile(
    path.join(input.qa_dir, "source-notes.txt"),
    "Source artwork: " + input.source_ai + "\nFront render: " + input.outputs.front_right + "\nBack render: " + input.outputs.back_left + "\n",
  );

  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(input.pptx_path);
  console.log(JSON.stringify({ pptx: input.pptx_path, qa_dir: input.qa_dir }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
