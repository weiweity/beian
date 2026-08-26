/** 确认单底部工艺表。前后端同一条：只认字段名开头，避免「备案版本号」被误杀。 */
export function skipPackSheetField(field?: string): boolean {
  return /^(工艺说明|颜色要求|版本号|更新内容)($|[\s：:·])/.test(String(field || "").trim());
}
