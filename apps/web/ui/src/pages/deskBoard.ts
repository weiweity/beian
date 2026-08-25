/** 两台看板共用：短 ID、工作时间、待审核文案。列布局在 DeskCol。 */

export const PENDING_REVIEW = "待审核";

export function deskShortId(id: string): string {
  const t = (id || "").trim();
  if (t.length <= 8) return t || "—";
  return t.slice(0, 8);
}

export function deskClock(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type DeskStatusColor = "default" | "warning" | "error" | "processing" | "success";

export type DeskCardRow = {
  id: string;
  title: string;
  statusText: string;
  statusColor: DeskStatusColor;
  actor?: string;
  at?: string;
  live?: string | null;
  error?: string | null;
};
