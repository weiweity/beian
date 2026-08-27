import type { MockupJob, TaskDetail } from "./api";

type JobHandoff = {
  review: TaskDetail | null;
  mockup: MockupJob | null;
};

const handoff: JobHandoff = { review: null, mockup: null };

/**
 * 创建接口已经返回 queued 快照；路由切换只交接这份快照，目标页仍会立即向服务端重验。
 * 这不是第二份作业状态源，只用于消除“提交页 loader → 空详情页 → 详情页 loader”的闪烁。
 */
export function rememberReviewHandoff(task: TaskDetail): void {
  handoff.review = task;
}

export function reviewHandoffFor(id: string | null): TaskDetail | null {
  return id && handoff.review?.id === id ? handoff.review : null;
}

export function forgetReviewHandoff(id: string | null): void {
  if (id && handoff.review?.id === id) handoff.review = null;
}

export function rememberMockupHandoff(job: MockupJob): void {
  handoff.mockup = job;
}

export function mockupHandoffFor(id: string | null): MockupJob | null {
  return id && handoff.mockup?.id === id ? handoff.mockup : null;
}

export function forgetMockupHandoff(id: string | null): void {
  if (id && handoff.mockup?.id === id) handoff.mockup = null;
}

export function resetJobHandoffsForTest(): void {
  handoff.review = null;
  handoff.mockup = null;
}
