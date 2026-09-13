import type { RenderGenerationCreate, RenderGenerationRow, RenderMutation } from "../api";
import { clampStudioLight } from "./mockupStudio";

export type PendingRenderRequest = {request:RenderGenerationCreate;mutationId?:string};
type SessionStore = Pick<Storage,"getItem" | "setItem" | "removeItem">;
const storageKey = (jobId:string) => `wb_render_request:${jobId}`;
const requestKeys = ["client_request_id","mode","source_generation_id","expected_current_generation_id","studio_adjustment"];

export function createRenderRequest(current:string,product:number,background:number,id:string): RenderGenerationCreate {
  return {client_request_id:id,mode:"legacy_relight",source_generation_id:current,expected_current_generation_id:current,
    studio_adjustment:{product_light:clampStudioLight(product),background_light:clampStudioLight(background)}};
}

export function readPendingRenderRequest(jobId:string,storage?:SessionStore): PendingRenderRequest | null {
  try {
    const text=(storage ?? sessionStorage).getItem(storageKey(jobId));
    if (!text || text.length > 4096) return null;
    const pending=JSON.parse(text) as PendingRenderRequest;
    if (!pending || typeof pending !== "object" || Object.keys(pending).some(key=>!["request","mutationId"].includes(key))) return null;
    const r=pending.request;
    if (!r || Object.keys(r).some(key=>!requestKeys.includes(key)) || !/^[a-zA-Z0-9_-]{8,128}$/.test(r.client_request_id)
      || r.mode !== "legacy_relight" || typeof r.source_generation_id !== "string" || r.source_generation_id.length > 128
      || !r.source_generation_id || r.source_generation_id !== r.expected_current_generation_id
      || (pending.mutationId !== undefined && (typeof pending.mutationId !== "string" || pending.mutationId.length > 128))) return null;
    const canonical=createRenderRequest(r.source_generation_id,r.studio_adjustment.product_light,r.studio_adjustment.background_light,r.client_request_id);
    if (JSON.stringify(canonical.studio_adjustment) !== JSON.stringify(r.studio_adjustment)) return null;
    return {request:canonical,...(pending.mutationId ? {mutationId:pending.mutationId} : {})};
  } catch { return null; }
}

/** Persist before POST. Storage failure prevents creating an unrecoverable click identity. */
export function savePendingRenderRequest(jobId:string,pending:PendingRenderRequest | null,storage?:SessionStore): void {
  const target=storage ?? sessionStorage;
  if (pending) {
    const text=JSON.stringify(pending); target.setItem(storageKey(jobId),text);
    if (target.getItem(storageKey(jobId)) !== text) throw new Error("本页无法保存请求号，请允许会话存储后再操作");
  } else target.removeItem(storageKey(jobId));
}

export function renderCapabilityCopy(reason?:string): string {
  const reasons:Record<string,string>={
    permission_denied:"此账号只能查看出图版本", mutation_busy:"这单正在生成或切换版本，请稍后操作",
    ownership_unconfirmed:"上次执行是否结束尚未确认，请等待核验", production_registration_disabled:"重新出图尚未开放，历史仍可查看",
    runtime_quality_unwired:"产物校验尚未接通，暂不能重新出图", process_containment_unavailable:"执行环境尚未就绪",
    upgrade_unwired:"新版出图尚未开放", upgrade_candidate_identity_invalid:"候选身份无效，暂不能升级",
    source_changed:"底稿已变化，请重新核对", current_changed:"当前版本已变化，请查看后再操作",
    idempotency_capacity:"本单暂不能继续生成新版本，历史仍可查看", history_capacity:"版本记录容量已满，当前图片仍可查看",
    audit_pending:"上次切换尚待记账，当前图片仍可用", generation_corrupt:"版本文件未通过校验，不能混用其他版本",
    generation_missing:"还没有可切换的历史版本", request_id_conflict:"本次请求内容已变化，请重新操作",
    payload_invalid:"请求参数无效，请刷新后再操作", cursor_invalid:"版本列表已变化，请重新打开",
  };
  return reasons[reason || ""] || "暂不可用，请稍后再试";
}

export function renderMutationLine(mutation?:RenderMutation): string {
  if (!mutation) return "";
  if (mutation.status === "failed") return "本次未完成，当前图片未变";
  if (mutation.status === "succeeded") return "本次出图已完成";
  return `正在按旧版重新出图${mutation.stage ? ` · ${mutation.stage}` : ""} · 当前图片仍可用`;
}

export function renderVersionLabel(row:Pick<RenderGenerationRow,"mode" | "quality_status">): string {
  const action=row.mode === "legacy_import" ? "原图存档" : row.mode === "legacy_relight" ? "旧版重新出图" : "新版出图";
  return `${action} · ${row.quality_status === "runtime_verified" ? "产物校验完成" : row.quality_status === "unwired" ? "未补验" : "校验未完成"}`;
}
