/** 打样失败给人看。不要把 Windows 路径和模板坐标塞进看板标签。 */

export function mockupFailTag(): string {
  return "打样中断";
}

export function mockupFailReason(raw?: string | null): string {
  const t = String(raw || "").replace(/\s+/g, " ").trim();
  if (!t) return "打样中断，点开看原因。";
  if (/没有刀线或刀版/.test(t)) {
    return "这张稿没有刀线/刀版层，自动打样读不到展开图。转曲时请保留刀线或刀版。";
  }
  if (/刀线读不出结构/.test(t)) {
    return "刀线在，但折不成盒面。看展开图是不是花盒或膜袋，或刀线画在印刷层里了。";
  }
  if (/画板尺寸与模板不符/.test(t)) {
    return "刀线没读成结构，画板也和已登记刀模对不上。不要硬套方盒。";
  }
  const stripped = t
    .replace(/文件\s*=\s*[A-Za-z]:\\[^\s，,]*/g, "")
    .replace(/[A-Za-z]:\\[^\s，,]+/g, "")
    .replace(/[，,\s]+$/g, "")
    .trim();
  return (stripped || "打样中断").slice(0, 180);
}
