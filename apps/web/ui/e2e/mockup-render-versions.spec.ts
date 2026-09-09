import { carton } from "./fixtures/glbFixture";
import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MockupJob, RenderGenerationCreate, RenderGenerationRow, RenderMutation } from "../src/api";

// Browser interactions against built application code and SYNTHETIC protocol/images only.
// Every URL is intercepted, including non-API URLs. No Hono/Blender/production access.
let dist:string;
const assets=new Map<string,Buffer>();
test.beforeAll(()=>{
  dist=mkdtempSync(join(tmpdir(),"beian-rf04-e2e-"));
  execFileSync("npm",["run","build","--","--outDir",dist],{cwd:fileURLToPath(new URL("../",import.meta.url)),timeout:60_000,stdio:"pipe"});
  for(const name of readdirSync(join(dist,"assets"))) assets.set(`/assets/${name}`,readFileSync(join(dist,"assets",name)));
});
test.afterAll(()=>{if(dist)rmSync(dist,{recursive:true});});
const ID="af0400000001", LEGACY="legacy-current-v2-"+"a".repeat(64), G0="g0-legacy-original", G1="g1-legacy-relight-12345678-abcdef12";
const deferred=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};


function model() {
  const files=["white_a","white_b","white_a_ground","white_b_ground","white_a_set","white_b_set",
    "white_a_card","white_b_card","white_a_ground_card","white_b_ground_card","white_a_set_card","white_b_set_card","glb",
    "read_front","read_back","read_left","read_right"].map(key=>({key,name:key+(key === "glb" ? ".glb" : ".png")}));
  const job:MockupJob={id:ID,title:"SYNTHETIC 出图版本",owner:"ou_synthetic",status:"done",files,current_render_generation_id:LEGACY,
    render_generation_capabilities:{history:{allowed:true},activate:{allowed:false,reason:"generation_missing"},legacy_relight:{allowed:true},upgrade:{allowed:false,reason:"upgrade_unwired"}}};
  const history:RenderGenerationRow[]=[];
  const facts=new Map<string,{body:RenderGenerationCreate;mutation:RenderMutation}>();
  const calls:Array<{method:string;path:string;body?:unknown}>=[];
  const urls:string[]=[];
  const unknown:string[]=[];
  let loseNext=false;
  return {job,history,facts,calls,urls,unknown,
    lose:()=>{loseNext=true;},takeLoss:()=>{const next=loseNext;loseNext=false;return next;},
    complete:(success:boolean)=>{
      const mutation=job.render_mutation!;mutation.status=success ? "succeeded" : "failed";mutation.stage=success ? "已提交" : undefined;
      if(success){
        if(!history.length)history.push({generation_id:G0,mode:"legacy_import",profile:"synthetic",quality_status:"unwired",created_at:"2026-09-06T10:00:00Z",current:false});
        if(!history.some(row=>row.generation_id===G1))history.unshift({generation_id:G1,mode:"legacy_relight",profile:"synthetic",quality_status:"runtime_verified",created_at:"2026-09-06T10:01:00Z",current:true});
        job.current_render_generation_id=G1;job.has_render_generations=true;
      }
      job.render_generation_capabilities!.legacy_relight={allowed:true};
      job.render_generation_capabilities!.activate={allowed:Boolean(job.has_render_generations)};
    },
  };
}

async function serve(page:Page,state:ReturnType<typeof model>,options:{oldFull?:ReturnType<typeof deferred>;oldGlb?:ReturnType<typeof deferred>;reader?:boolean;detail?:()=>MockupJob}={}) {
  await page.route("**/*",async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
    const json=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(!path.startsWith("/api/")) {
      const body=assets.get(path) || (path.startsWith("/mockup") ? readFileSync(join(dist,"index.html")) : null);
      return body ? route.fulfill({body,contentType:path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html"})
        : route.fulfill({status:404,body:"synthetic asset not supplied"});
    }
    const body=request.postData() ? request.postDataJSON() : undefined;state.calls.push({method,path,body});
    if(path === "/api/auth/me")return json({logged_in:true,display_name:"SYNTHETIC 用户",open_id:"ou_synthetic",role:options.reader ? "viewer" : "reviewer",perms:options.reader ? ["read"] : ["read","create","confirm_structure"]});
    if(path === "/api/status" || path === "/api/health")return json({ok:true,version:"0.0.0.0",jobs:{}});
    if(path === "/api/uploads" || path === "/api/tasks")return json([]);
    if(path === "/api/mockups")return json([state.job]);
    if(path === `/api/mockups/${ID}`)return json(options.detail?.() || state.job);
    const base=`/api/mockups/${ID}/render-generations`;
    if(path === base && method === "GET")return json({items:state.history,next_cursor:null});
    if(path === base && method === "POST") {
      const input=body as RenderGenerationCreate;
      const existing=state.facts.get(input.client_request_id);
      if(!existing && input.expected_current_generation_id !== state.job.current_render_generation_id)return json({code:"render_generation_stale",reason:"current_changed",message:"当前版本已变化"},409);
      if(!existing){
        const mutation:RenderMutation={id:`m${String(state.facts.size+1).padStart(16,"0")}`,mode:"legacy_relight",status:"running",stage:"出图"};
        state.facts.set(input.client_request_id,{body:input,mutation});state.job.render_mutation=mutation;
        state.job.render_generation_capabilities!.legacy_relight={allowed:false,reason:"mutation_busy"};
        state.job.render_generation_capabilities!.activate={allowed:false,reason:"mutation_busy"};
      } else if(JSON.stringify(existing.body) !== JSON.stringify(input))return json({code:"render_generation_invalid",reason:"request_id_conflict",message:"同号异内容"},409);
      if(state.takeLoss())return route.abort("failed");
      return json({mutation:state.facts.get(input.client_request_id)!.mutation,current_render_generation_id:state.job.current_render_generation_id,
        has_render_generations:Boolean(state.job.has_render_generations),job_status:"done"},202);
    }
    if(path.startsWith(base+"/") && path.endsWith("/activate")) {
      if(body.expected_current_generation_id !== state.job.current_render_generation_id)return json({code:"render_generation_stale",reason:"current_changed",message:"当前版本已变化"},409);
      state.job.current_render_generation_id=path.slice(base.length+1,-"/activate".length);
      if(state.takeLoss())return route.abort("failed");
      return json(state.job);
    }
    if(path.startsWith(`/api/mockups/${ID}/files/`)) {
      state.urls.push(url.href);const key=path.split("/").pop()!,generation=url.searchParams.get("generation_id");
      if(!key.startsWith("read_") && !generation){state.unknown.push(`unbound:${key}`);return route.fulfill({status:409});}
      if(generation === LEGACY && key === "glb" && options.oldGlb)await options.oldGlb.promise;
      if(generation === LEGACY && !key.endsWith("_card") && key !== "glb" && options.oldFull)await options.oldFull.promise;
      if(key === "glb")return route.fulfill({contentType:"model/gltf-binary",body:carton()});
      const layer=key.includes("ground") || key.includes("set");
      const color=layer ? "white" : generation === G1 ? "rgb(20,50,230)" : "rgb(220,60,30)";
      return route.fulfill({contentType:"image/svg+xml",body:`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect width="80" height="96" fill="${color}"/></svg>`});
    }
    state.unknown.push(`${method}:${path}`);return json({message:"synthetic route missing"},404);
  });
}

async function centerColor(page:Page) {
  return page.locator('canvas[aria-label="正面与侧面成片"]').evaluate((canvas:HTMLCanvasElement)=>
    Array.from(canvas.getContext("2d")!.getImageData(canvas.width/2,canvas.height/2,1,1).data));
}

test("首次生成、运行中旧代下载、晚到 full/ground/GLB 不回写、历史切回与失败留图",async({page})=>{
  test.setTimeout(45_000);
  const state=model(),oldFull=deferred(),oldGlb=deferred();
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await serve(page,state,{oldFull,oldGlb});
  try {
    await page.goto(`/mockup/${ID}`,{waitUntil:"domcontentloaded"});
    await page.locator(".mockup-backdrop-switch").getByText("白底",{exact:true}).click();
    await expect.poll(async()=>{const c=await centerColor(page);return c[0]>c[2];}).toBe(true);
    const download=page.waitForEvent("download");
    await page.getByRole("button",{name:"下载正面 + 侧面",exact:true}).click();
    await page.getByRole("button",{name:"出图版本",exact:true}).click();
    await page.getByRole("button",{name:"按旧版重新出图",exact:true}).click();
    await expect.poll(()=>state.facts.size).toBe(1);
    await expect(page.locator(".mockup-version-status")).toContainText("当前图片仍可用");
    await expect(page.locator(".wait-card")).toHaveCount(0);
    state.complete(true);
    await expect(page.locator(".mockup-sheet-photos")).toHaveAttribute("data-render-generation",G1);
    await expect.poll(async()=>{const c=await centerColor(page);return c[2]>c[0];}).toBe(true);
    oldFull.release();oldGlb.release();
    const saved=await download;const bytes=readFileSync((await saved.path())!);
    const pixel=await page.evaluate(async data=>{const image=await createImageBitmap(new Blob([new Uint8Array(data)]));
      const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext("2d")!;ctx.drawImage(image,0,0);image.close();return [...ctx.getImageData(40,48,1,1).data];},Array.from(bytes));
    expect(pixel[0]).toBeGreaterThan(pixel[2]);
    await expect.poll(async()=>{const c=await centerColor(page);return c[2]>c[0];}).toBe(true);
    await expect(page.locator("model-viewer")).toHaveAttribute("src",new RegExp(`generation_id=${G1}`));
    await expect(page.getByRole("link",{name:"下载 GLB",exact:true})).toHaveAttribute("href",new RegExp(`generation_id=${G1}`));
    state.lose(); // Lost activation response: GET confirms target, no second activation POST.
    await page.locator(`[data-generation-id="${G0}"]`).getByRole("button",{name:"使用此版本"}).click();
    await expect(page.locator(".mockup-sheet-photos")).toHaveAttribute("data-render-generation",G0);
    expect(state.facts.size).toBe(1);
    expect(state.calls.filter(call=>call.path.endsWith("/activate"))).toHaveLength(1);
    await page.locator(".mockup-version-actions").getByRole("button",{name:"按旧版重新出图"}).click();await expect.poll(()=>state.facts.size).toBe(2);
    state.complete(false);
    await expect(page.locator(".mockup-version-status")).toContainText("当前图片未变");
    await expect(page.locator(".mockup-sheet-photos")).toHaveAttribute("data-render-generation",G0);
    expect(state.urls.some(url=>url.includes("white_a_ground_card"))).toBe(true);
    expect(state.urls.some(url=>url.includes("white_a_set_card"))).toBe(true);
    expect(state.unknown).toEqual([]);expect(errors).toEqual([]);
  } finally {oldFull.release();oldGlb.release();}
});

test("响应丢失后刷新仅恢复请求，显式确认复用同号同内容",async({page})=>{
  const state=model();state.lose();await serve(page,state);
  await page.goto(`/mockup/${ID}`);await page.getByRole("button",{name:"出图版本",exact:true}).click();
  await page.getByRole("button",{name:"按旧版重新出图",exact:true}).click();
  await expect(page.locator(".mockup-version-status")).toContainText("未确认这次请求");
  const original=[...state.facts.values()][0].body;state.complete(true);
  const count=state.calls.filter(call=>call.method === "POST").length;
  await page.reload();await page.getByRole("button",{name:"出图版本",exact:true}).click();
  expect(state.calls.filter(call=>call.method === "POST")).toHaveLength(count);
  await page.getByRole("button",{name:"确认上次请求",exact:true}).click();
  // The loading icon may remain during its exit animation; assert the action is usable.
  await expect(page.getByRole("button",{name:/按旧版重新出图$/})).toBeEnabled();
  const posts=state.calls.filter(call=>call.method === "POST");expect(posts).toHaveLength(2);
  expect(posts[1].body).toEqual(original);expect(state.facts.size).toBe(1);
  expect(await page.evaluate(()=>sessionStorage.getItem("wb_render_request:af0400000001"))).toBeNull();
  expect(state.unknown).toEqual([]);
});

test("第二 tab 的旧 CAS 得 409；保留灯光，只刷新不自动重投",async({page,context})=>{
  const state=model();await serve(page,state);
  const second=await context.newPage();const snapshot=structuredClone(state.job);let stale=true;
  await serve(second,state,{detail:()=>stale ? snapshot : state.job});
  await page.goto(`/mockup/${ID}`);await second.goto(`/mockup/${ID}`);
  await second.getByRole("button",{name:"调灯",exact:true}).click();
  const light=second.locator('#mockup-studio-lights input[type="range"]').first();await light.fill("1.2");
  await second.getByRole("button",{name:"出图版本",exact:true}).click();
  await page.getByRole("button",{name:"出图版本",exact:true}).click();await page.getByRole("button",{name:"按旧版重新出图",exact:true}).click();
  await expect.poll(()=>state.facts.size).toBe(1);state.complete(true);
  stale=false;await second.getByRole("button",{name:"按旧版重新出图",exact:true}).click();
  await expect(second.locator(".mockup-version-status")).toContainText("当前版本已变化");
  await expect(second.locator(".mockup-sheet-photos")).toHaveAttribute("data-render-generation",G1);
  await expect(light).toHaveValue("1.2");
  expect(state.calls.filter(call=>call.method === "POST")).toHaveLength(2);expect(state.facts.size).toBe(1);
  expect(state.unknown).toEqual([]);await second.close();
});

test("viewer 只读与生产关闭态仍能看历史；窄屏入口可用键盘且没有写按钮",async({page})=>{
  const state=model();state.job.current_render_generation_id=G0;state.job.has_render_generations=true;
  state.history.push({generation_id:G0,mode:"legacy_import",profile:"synthetic",quality_status:"unwired",current:true,created_at:"2026-09-06T10:00:00Z"});
  for(const action of ["activate","legacy_relight","upgrade"] as const)state.job.render_generation_capabilities![action]={allowed:false,reason:"permission_denied"};
  await page.setViewportSize({width:390,height:844});await serve(page,state,{reader:true});await page.goto(`/mockup/${ID}`);
  const toggle=page.getByRole("button",{name:"出图版本",exact:true});await toggle.focus();await page.keyboard.press("Enter");
  await expect(page.getByText("原图存档 · 未补验",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"使用此版本"})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"按旧版重新出图"})).toHaveCount(0);
  const box=await page.locator('button[aria-controls="mockup-render-versions"]').boundingBox();expect(box!.height).toBeGreaterThanOrEqual(40);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(await page.locator(".mockup-versions").evaluate(node=>node.getBoundingClientRect().right<=document.querySelector(".stage")!.getBoundingClientRect().right)).toBe(true);
  expect(await page.locator(".stage").evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
  await page.screenshot({path:test.info().outputPath("rf04-viewer-narrow.png"),fullPage:true});
  expect(state.calls.filter(call=>call.method === "POST")).toHaveLength(0);expect(state.unknown).toEqual([]);
});

test("生产执行门关闭只禁新建，历史与原图下载仍可用",async({page})=>{
  const state=model();state.job.current_render_generation_id=G0;state.job.has_render_generations=true;
  state.job.render_generation_capabilities!.legacy_relight={allowed:false,reason:"production_registration_disabled"};
  state.job.render_generation_capabilities!.activate={allowed:true};
  state.history.push({generation_id:G0,mode:"legacy_import",profile:"synthetic",quality_status:"unwired",current:true,created_at:"2026-09-06T10:00:00Z"});
  await serve(page,state);await page.goto(`/mockup/${ID}`);await page.getByRole("button",{name:"出图版本",exact:true}).click();
  await expect(page.getByRole("button",{name:"按旧版重新出图",exact:true})).toBeDisabled();
  await expect(page.getByRole("button",{name:"升级新版",exact:true})).toBeDisabled();
  await expect(page.locator(".mockup-version-actions")).toContainText("重新出图尚未开放，历史仍可查看");
  await expect(page.getByText("原图存档 · 未补验",{exact:true})).toBeVisible();
  await expect.poll(async()=>{const c=await centerColor(page);return c[0]>c[2];}).toBe(true);
  const download=page.waitForEvent("download");await page.getByRole("button",{name:"下载正面 + 侧面",exact:true}).click();await download;
  await page.screenshot({path:test.info().outputPath("rf04-versions-desktop.png"),fullPage:true});
  expect(state.calls.filter(call=>call.method === "POST")).toHaveLength(0);expect(state.unknown).toEqual([]);
});

test("会话存储失败时重复点击都不提交；恢复后才创建可追溯请求",async({page})=>{
  const state=model();await serve(page,state);
  await page.addInitScript(()=>{
    const original=Storage.prototype.setItem;
    Object.defineProperty(window,"__rf04DenyRequestStorage",{value:true,writable:true});
    Storage.prototype.setItem=function(key,value){
      if(key.startsWith("wb_render_request:") && (window as unknown as {__rf04DenyRequestStorage:boolean}).__rf04DenyRequestStorage) {
        throw new DOMException("synthetic quota denial","QuotaExceededError");
      }
      return original.call(this,key,value);
    };
  });
  await page.goto(`/mockup/${ID}`);await page.getByRole("button",{name:"出图版本",exact:true}).click();
  const create=page.getByRole("button",{name:"按旧版重新出图",exact:true});
  await create.click();
  await expect(page.locator(".mockup-version-status")).toContainText("本页无法保存请求号，尚未提交");
  await create.click();
  await expect(page.locator(".mockup-version-status")).toContainText("请允许会话存储后再操作");
  expect(state.calls.filter(call=>call.method === "POST")).toHaveLength(0);
  expect(state.facts.size).toBe(0);
  expect(await page.evaluate(()=>sessionStorage.getItem("wb_render_request:af0400000001"))).toBeNull();
  await expect(page.locator(".mockup-sheet-photos")).toHaveAttribute("data-render-generation",LEGACY);
  await page.evaluate(()=>{(window as unknown as {__rf04DenyRequestStorage:boolean}).__rf04DenyRequestStorage=false;});
  await create.click();await expect.poll(()=>state.facts.size).toBe(1);
  const accepted=[...state.facts.values()][0];
  await expect.poll(async()=>JSON.parse((await page.evaluate(()=>sessionStorage.getItem("wb_render_request:af0400000001"))) || "null")?.mutationId).toBe(accepted.mutation.id);
  const pending=JSON.parse((await page.evaluate(()=>sessionStorage.getItem("wb_render_request:af0400000001")))!);
  expect(pending.request).toEqual(accepted.body);
  expect(state.calls.filter(call=>call.method === "POST")).toHaveLength(1);expect(state.unknown).toEqual([]);
});

test("历史分页失败保留原图与已读记录，重新读取后可加载下一页",async({page})=>{
  const state=model();state.job.current_render_generation_id=G1;state.job.has_render_generations=true;
  const first:RenderGenerationRow={generation_id:G1,mode:"legacy_relight",profile:"synthetic",quality_status:"runtime_verified",created_at:"2026-09-06T10:01:00Z",current:true};
  const second:RenderGenerationRow={generation_id:G0,mode:"legacy_import",profile:"synthetic",quality_status:"unwired",created_at:"2026-09-06T10:00:00Z",current:false};
  const cursors:Array<string | null>=[];let failNext=true;
  await serve(page,state);
  await page.route(new RegExp(`/api/mockups/${ID}/render-generations(?:\\?.*)?$`),async route=>{
    if(route.request().method() !== "GET")return route.fallback();
    const cursor=new URL(route.request().url()).searchParams.get("cursor");cursors.push(cursor);
    if(cursor && failNext){failNext=false;return route.fulfill({status:400,contentType:"application/json",body:JSON.stringify({code:"render_generation_invalid",reason:"cursor_invalid",message:"合成过期分页"})});}
    return route.fulfill({contentType:"application/json",body:JSON.stringify({items:cursor ? [second] : [first],next_cursor:cursor ? null : "synthetic-page-two"})});
  });
  await page.goto(`/mockup/${ID}`);await page.getByRole("button",{name:"出图版本",exact:true}).click();
  await expect(page.locator(".mockup-version-list > li")).toHaveCount(1);
  await page.getByRole("button",{name:"更多版本",exact:true}).click();
  await expect(page.locator(".mockup-versions [role=alert]")).toContainText("版本列表已变化，请重新打开");
  await expect(page.locator(`[data-generation-id="${G1}"]`)).toBeVisible();
  await expect(page.locator(".mockup-sheet-photos")).toHaveAttribute("data-render-generation",G1);
  await expect.poll(async()=>{const c=await centerColor(page);return c[2]>c[0];}).toBe(true);
  await page.getByRole("button",{name:"重新读取",exact:true}).click();
  await expect(page.locator(".mockup-versions [role=alert]")).toHaveCount(0);
  await page.getByRole("button",{name:"更多版本",exact:true}).click();
  await expect(page.locator(".mockup-version-list > li")).toHaveCount(2);
  await expect(page.locator(`[data-generation-id="${G0}"]`)).toContainText("原图存档 · 未补验");
  await expect(page.getByRole("button",{name:"更多版本",exact:true})).toHaveCount(0);
  expect(cursors).toEqual([null,"synthetic-page-two",null,"synthetic-page-two"]);
  expect(state.calls.filter(call=>call.method === "POST")).toHaveLength(0);expect(state.unknown).toEqual([]);
});

test("旧代图片报错仅刷新一次，新代已显示后迟到的旧详情不能回写",async({page})=>{
  const state=model(),oldDetail=deferred();const snapshot=structuredClone(state.job);
  let detailReads=0,lateDelivered=false;
  await serve(page,state);
  await page.route(new RegExp(`/api/mockups/${ID}$`),async route=>{
    detailReads++;
    const body=detailReads === 2 ? snapshot : structuredClone(state.job);
    if(detailReads === 2){await oldDetail.promise;await route.fulfill({contentType:"application/json",body:JSON.stringify(body)});lateDelivered=true;return;}
    return route.fulfill({contentType:"application/json",body:JSON.stringify(body)});
  });
  await page.route(new RegExp(`/api/mockups/${ID}/files/white_[ab]_ground(?:_card)?\\?`),async route=>{
    if(new URL(route.request().url()).searchParams.get("generation_id") !== LEGACY)return route.fallback();
    return route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({code:"render_generation_stale",reason:"current_changed"})});
  });
  try {
    await page.goto(`/mockup/${ID}`,{waitUntil:"domcontentloaded"});
    await expect.poll(()=>detailReads).toBe(2);
    await expect(page.locator(".mockup-sheet-photos")).toHaveAttribute("data-render-generation",LEGACY);
    state.job.current_render_generation_id=G1;state.job.has_render_generations=true;
    await page.getByRole("button",{name:"出图版本",exact:true}).click();
    await expect(page.locator(".mockup-sheet-photos")).toHaveAttribute("data-render-generation",G1);
    await expect.poll(async()=>{const c=await centerColor(page);return c[2]>c[0];}).toBe(true);
    oldDetail.release();await expect.poll(()=>lateDelivered).toBe(true);
    // Let response handlers and the next paint settle before observing retained current.
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    await expect(page.locator(".mockup-sheet-photos")).toHaveAttribute("data-render-generation",G1);
    await expect.poll(async()=>{const c=await centerColor(page);return c[2]>c[0];}).toBe(true);
    expect(state.calls.filter(call=>call.method === "POST")).toHaveLength(0);expect(state.unknown).toEqual([]);
  } finally {oldDetail.release();}
});

test("GLB 显示桌墙与原始下载分离，切背景和全屏不发起作业", async ({ page }) => {
  const state = model();
  await serve(page, state);
  await page.goto(`/mockup/${ID}`);
  const viewer = page.locator("model-viewer");
  const frame = page.locator(".mockup-sheet-glb");
  await expect(frame.getByRole("button", {name:"复位模型视角"})).toBeEnabled();
  await expect(viewer).toHaveAttribute("src", /^blob:/);
  await expect(viewer).toHaveAttribute("camera-orbit", /^35deg 72deg .*m$/);
  await expect(frame).toHaveCSS("background-image", "none");
  const download = await page.getByRole("link", {name:"下载 GLB", exact:true}).getAttribute("href");
  await page.locator(".mockup-backdrop-switch").getByText("银底", {exact:true}).click();
  await expect(viewer).toHaveAttribute("src", new RegExp(`generation_id=${LEGACY}`));
  await expect(frame).toHaveCSS("background-color", "rgb(196, 201, 208)");
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", {exact:true}).click();
  await expect(frame.getByRole("button", {name:"复位模型视角"})).toBeEnabled();
  await frame.getByRole("button", {name:"全屏截图", exact:true}).click();
  await expect.poll(() => frame.evaluate(el => document.fullscreenElement === el)).toBe(true);
  await expect(viewer).toHaveAttribute("src", /^blob:/);
  await page.evaluate(() => document.exitFullscreen());
  await expect(page.getByRole("link", {name:"下载 GLB",exact:true})).toHaveAttribute("href", download!);
  expect(state.calls.filter(call => call.method !== "GET")).toEqual([]);
  expect(state.unknown).toEqual([]);
});
