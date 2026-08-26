import type { FieldHit, TaskDetail } from "../api";

export function shouldUseReworkView(task: TaskDetail | null): boolean {
  return Boolean(
    (Array.isArray(task?.hits_v2) && task.hits_v2.length > 0) ||
      (Array.isArray(task?.pages_v2) && task.pages_v2.length > 0),
  );
}

/** 第二轮没有命中结果时，严格回退第一轮；不能把待处理字段清空。 */
export function reviewHits(task: TaskDetail | null, useV2: boolean): FieldHit[] {
  if (useV2 && Array.isArray(task?.hits_v2) && task.hits_v2.length > 0) return task.hits_v2;
  return Array.isArray(task?.hits) ? task.hits : [];
}
