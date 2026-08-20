/** 空列表不画三栏看板。加载中、零条、出错都不抬表头。搜到零条才画空表。 */
export function shouldShowTaskBoard(rowCount: number, submitted: string): boolean {
  return rowCount > 0 || Boolean(submitted);
}
