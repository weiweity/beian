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
  const title = input.display_name.replace("达肤妍男士", "达肤妍男士\n");
  const dim = input.dimensions_mm;

  const cover = presentation.slides.add();
  cover.background.fill = "#FFFFFF";
  addText(cover, "brand-label", "D · 达肤妍", { left: 58, top: 52, width: 440, height: 34 }, {
    fontSize: 22,
    bold: true,
    color: "#585D66",
  });
  addText(cover, "product-title", title, { left: 58, top: 155, width: 540, height: 180 }, {
    fontSize: 68,
    bold: true,
    lineSpacing: 0.94,
  });
  addRule(cover, "accent-rule", 58, 366, 128);
  addText(cover, "deck-subtitle", "3D 包装展示", { left: 58, top: 395, width: 440, height: 52 }, {
    fontSize: 30,
    color: "#30343A",
  });
  addText(cover, "deck-meta", input.code + "  ·  正面与右侧", { left: 58, top: 602, width: 460, height: 36 }, {
    fontSize: 22,
    color: "#777C84",
  });
  addImage(
    cover,
    "front-right-render",
    frontBytes,
    input.display_name + "包装正面与右侧白底3D渲染",
    { left: 620, top: 18, width: 630, height: 674 },
  );
  addText(cover, "page-number", "01", { left: 1180, top: 668, width: 52, height: 24 }, {
    fontSize: 16,
    color: "#888D95",
    alignment: "right",
  });
  cover.speakerNotes.textFrame.setText(sourceNotes(input, input.outputs.front_right, "正面与右侧3D图"));

  const detail = presentation.slides.add();
  detail.background.fill = "#FFFFFF";
  addText(detail, "detail-title", "背面与左侧信息清晰呈现", { left: 58, top: 44, width: 1110, height: 68 }, {
    fontSize: 48,
    bold: true,
  });
  addRule(detail, "detail-accent-rule", 58, 126, 128);
  addImage(
    detail,
    "back-left-render",
    backBytes,
    input.display_name + "包装背面与左侧白底3D渲染",
    { left: 42, top: 145, width: 760, height: 530 },
  );
  addText(detail, "view-label", input.code + " · " + input.display_name, { left: 840, top: 190, width: 350, height: 42 }, {
    fontSize: 24,
    bold: true,
    color: "#8A684F",
  });
  addText(detail, "dimensions-label", "花盒尺寸", { left: 840, top: 276, width: 350, height: 38 }, {
    fontSize: 24,
    bold: true,
  });
  addText(
    detail,
    "dimensions-value",
    dim.width + " × " + dim.depth + " × " + dim.height + " mm",
    { left: 840, top: 322, width: 360, height: 42 },
    { fontSize: 24, color: "#4E535A" },
  );
  addText(
    detail,
    "view-notes",
    "背面：产品说明与条码区域\n左侧：产品信息排版\n背景：白底 3D 影棚",
    { left: 840, top: 416, width: 360, height: 148 },
    { fontSize: 24, color: "#4E535A", lineSpacing: 1.35 },
  );
  addText(detail, "page-number", "02", { left: 1180, top: 668, width: 52, height: 24 }, {
    fontSize: 16,
    color: "#888D95",
    alignment: "right",
  });
  detail.speakerNotes.textFrame.setText(sourceNotes(input, input.outputs.back_left, "背面与左侧3D图"));

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
