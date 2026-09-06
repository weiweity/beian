import { useEffect, useRef, useState } from "react";
import { Button } from "antd";
import { api, ApiError, type MockupJob, type RenderGenerationHistory } from "../api";
import { createRenderRequest, readPendingRenderRequest, savePendingRenderRequest,
  renderCapabilityCopy, renderMutationLine, renderVersionLabel, type PendingRenderRequest } from "./mockupRenderVersions";
import "../styles/renderVersions.css";

/** An independent mutation never replaces the completed job's three images with WaitCard. */
export function RenderVersions({job,open,productLight,backgroundLight,onJob}: {
  job:MockupJob;open:boolean;productLight:number;backgroundLight:number;onJob:(job:MockupJob)=>void;
}) {
  const [history,setHistory]=useState<RenderGenerationHistory>({items:[],next_cursor:null});
  const [historyBusy,setHistoryBusy]=useState(false);
  const [historyError,setHistoryError]=useState("");
  const [notice,setNotice]=useState("");
  const [writing,setWriting]=useState(false);
  const [pending,setPending]=useState<PendingRenderRequest | null>(()=>readPendingRenderRequest(job.id));
  const alive=useRef(true);
  const writingRef=useRef(false);
  const readEpoch=useRef(0);
  const historyEpoch=useRef(0);
  const caps=job.render_generation_capabilities;
  const inflight=job.render_mutation?.status === "queued" || job.render_mutation?.status === "running";
  const canManage=Boolean(caps && caps.legacy_relight.reason !== "permission_denied");

  useEffect(()=>{ alive.current=true; return ()=>{alive.current=false;readEpoch.current++;historyEpoch.current++;}; },[]);

  function remember(next:PendingRenderRequest | null) {
    savePendingRenderRequest(job.id,next);
    setPending(next);
  }

  async function refresh(): Promise<MockupJob | null> {
    const epoch=++readEpoch.current;
    const next=await api.refreshMockup(job.id);
    if (!alive.current || epoch !== readEpoch.current) return null;
    onJob(next);
    return next;
  }

  async function loadHistory(cursor?:string) {
    const epoch=++historyEpoch.current;
    setHistoryBusy(true); setHistoryError("");
    try {
      const page=await api.renderGenerations(job.id,cursor);
      if (!alive.current || epoch !== historyEpoch.current) return;
      setHistory(previous=>({items:cursor ? [...previous.items,...page.items] : page.items,next_cursor:page.next_cursor}));
    } catch(error) {
      if (alive.current && epoch === historyEpoch.current) setHistoryError(error instanceof ApiError ? renderCapabilityCopy(error.reason || undefined) : "版本列表暂时读不到");
    } finally { if (alive.current && epoch === historyEpoch.current) setHistoryBusy(false); }
  }

  useEffect(()=>{
    if (!open) return;
    void loadHistory();
    return ()=>{historyEpoch.current++;};
  },[open,job.id,job.current_render_generation_id,job.render_mutation?.status]);

  useEffect(()=>{
    if (!pending?.mutationId || pending.mutationId !== job.render_mutation?.id || inflight) return;
    try { remember(null); } catch { setNotice("请求已结束，但本页存储暂时不可用；再次确认不会重复出图"); }
  },[pending?.mutationId,job.render_mutation?.id,job.render_mutation?.status]);

  useEffect(()=>{
    if (!open && !inflight && !pending) return;
    let stopped=false;
    let reading=false;
    const timer=window.setInterval(()=>{
      if (writingRef.current || reading) return;
      reading=true;
      void refresh().catch(()=>{
        if (!stopped && alive.current) setNotice("版本状态暂时读不到，当前图片仍可用");
      }).finally(()=>{reading=false;});
    },2500);
    return ()=>{stopped=true;readEpoch.current++;window.clearInterval(timer);};
  },[open,inflight,pending?.request.client_request_id,job.id]);

  async function create() {
    if (writingRef.current || !canManage || (!pending && !caps?.legacy_relight.allowed)) return;
    writingRef.current=true; setWriting(true); setNotice(""); readEpoch.current++;
    let accepted:PendingRenderRequest;
    try {
      accepted=pending ?? {request:createRenderRequest(job.current_render_generation_id!,productLight,backgroundLight,`rf04-${crypto.randomUUID()}`)};
      remember(accepted);
    } catch {
      setNotice("本页无法保存请求号，尚未提交。请允许会话存储后再操作");
      writingRef.current=false;setWriting(false);return;
    }
    try {
      const result=await api.createRenderGeneration(job.id,accepted.request);
      if (!alive.current) return;
      remember(result.mutation.status === "queued" || result.mutation.status === "running"
        ? {...accepted,mutationId:result.mutation.id} : null);
      setNotice(result.mutation.status === "failed" ? "本次未完成，当前图片未变" : "");
      await refresh();
    } catch(error) {
      if (!alive.current) return;
      if (error instanceof ApiError && [400,401,403,409,412].includes(error.status)) {
        try { remember(null); } catch { /* same request remains safe to replay */ }
        setNotice(renderCapabilityCopy(error.reason || (error.status === 403 ? "permission_denied" : undefined)));
        // Refresh the view only; never substitute the current pointer into an automatic POST.
        try { await refresh(); } catch { /* retain current images and explicit error */ }
      } else {
        setNotice("未确认这次请求是否已收到。请确认上次请求；不会另建一单");
      }
    } finally {
      writingRef.current=false;
      if (alive.current) setWriting(false);
    }
  }

  async function activate(generation:string) {
    if (writingRef.current || !caps?.activate.allowed || !job.current_render_generation_id) return;
    writingRef.current=true;setWriting(true);setNotice("");readEpoch.current++;
    try {
      const next=await api.activateRenderGeneration(job.id,generation,job.current_render_generation_id);
      if (!alive.current) return;
      onJob(next);setNotice("已切换团队当前版本");
    } catch(error) {
      if (!alive.current) return;
      let next:MockupJob | null=null;
      try { next=await refresh(); } catch { /* no automatic activation retry */ }
      if (!alive.current) return;
      setNotice(next?.current_render_generation_id === generation ? "已切换团队当前版本"
        : error instanceof ApiError && error.status === 409 ? renderCapabilityCopy(error.reason || "current_changed")
        : "尚未确认切换结果，请查看当前版本后再操作");
    } finally {writingRef.current=false;if(alive.current)setWriting(false);}
  }

  const unresolved=Boolean(pending && (!pending.mutationId || pending.mutationId !== job.render_mutation?.id || !inflight));
  const mutationLine=renderMutationLine(job.render_mutation);
  return <>
    {notice || mutationLine || unresolved ? <p className="mockup-version-status" role="status" aria-live="polite">
      {notice || (unresolved ? "有一条上次请求尚待确认，当前图片仍可用" : mutationLine)}
    </p> : null}
    <section id="mockup-render-versions" className="mockup-versions" aria-label="出图版本" hidden={!open}>
      <p className="mockup-versions-help">使用此版本会切换团队共同看到的图片。调灯和换背景不会生成版本。</p>
      {canManage ? <div className="mockup-version-actions">
        <Button disabled={writing || (!unresolved && !caps?.legacy_relight.allowed)} loading={writing} onClick={()=>void create()}>
          {unresolved ? "确认上次请求" : "按旧版重新出图"}
        </Button>
        <Button disabled>升级新版</Button>
        <span>{unresolved ? "继续使用上次的请求号与灯光值" : !caps?.legacy_relight.allowed ? renderCapabilityCopy(caps?.legacy_relight.reason) : "当前灯光值会随这次请求保存"} · 新版出图尚未开放</span>
      </div> : null}
      {historyError ? <p className="mockup-versions-help" role="alert">{historyError} <Button disabled={historyBusy} onClick={()=>void loadHistory()}>重新读取</Button></p> : null}
      <ul className="mockup-version-list">
        {history.items.map(row=><li key={row.generation_id} data-generation-id={row.generation_id}>
          <time dateTime={row.created_at}>{new Date(row.created_at).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false})}</time>
          <span>{renderVersionLabel(row)}</span><span className="mockup-version-actor">{row.actor_label || "—"}</span>
          <span>{row.generation_id === job.current_render_generation_id ? "当前" : ""}</span>
          {canManage ? <Button size="small" disabled={writing || !caps?.activate.allowed || row.generation_id === job.current_render_generation_id}
            onClick={()=>void activate(row.generation_id)}>使用此版本</Button> : null}
        </li>)}
      </ul>
      {!historyBusy && !historyError && !history.items.length ? <p className="mockup-versions-help">还没有历史版本，当前原图仍可使用。</p> : null}
      {canManage && history.items.length > 0 && !caps?.activate.allowed ? <p className="mockup-versions-help">{renderCapabilityCopy(caps?.activate.reason)}</p> : null}
      {historyBusy ? <p className="mockup-versions-help" role="status">正在读取版本…</p> : history.next_cursor ? <Button onClick={()=>void loadHistory(history.next_cursor!)}>更多版本</Button> : null}
    </section>
  </>;
}
