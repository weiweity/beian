/** 打样失败给人看。不要把 Windows 路径和模板坐标塞进看板标签。 */

export function mockupFailTag(): string {
  return "打样中断";
}

export function mockupFailReason(raw?: string | null): string {
  const t = String(raw || "").replace(/\s+/g, " ").trim();
  if (!t) return "打样中断，点开看原因。";
  if (/画板尺寸与模板不符/.test(t)) {
    return "这张平面稿的画板和登记的方形花盒对不上。现在只接 47.5×47.5×177.5mm 花盒，别的刀模不能硬套。";
  }
  const stripped = t
    .replace(/文件\s*=\s*[A-Za-z]:\\[^\s，,]*/g, "")
    .replace(/[A-Za-z]:\\[^\s，,]+/g, "")
    .replace(/[，,\s]+$/g, "")
    .trim();
  return (stripped || "打样中断").slice(0, 180);
}
