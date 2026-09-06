import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { createSourceFile, ScriptKind, ScriptTarget, isFunctionDeclaration, transpileModule, ModuleKind } from "typescript";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = realpathSync(makeTestTempDir("beian-rf04-http-"));
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";
const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { saveMockup, readMockupFromDisk, applyRenderGenerationPatch, beginStructureConfirmation, finishStructureConfirmation } = await import("./mockup.js");
const { openRenderGenerationStore } = await import("./renderGenerations.js");
const { registerLocalRenderGenerationRuntime,getRenderGenerationRuntime } = await import("./renderGenerationRuntime.js");
const { resetJobsTestHooks } = await import("./jobs.js");
const reader = issueSessionForTest("合成访客","viewer","ou_rf04_reader");
const owner = issueSessionForTest("合成作者","reviewer","ou_rf04_owner");
const admin = issueSessionForTest("合成管理员","admin","ou_rf04_admin");
const stranger = issueSessionForTest("合成同事","reviewer","ou_rf04_stranger");
const contract = Buffer.from("rf04 synthetic contract");
const contractSha = createHash("sha256").update(contract).digest("hex");

function png(value = 11): Buffer {
  const chunk = (type:string,data:Buffer) => {
    const body = Buffer.concat([Buffer.from(type),data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for(let i=0;i<8;i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size,body,tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1,4); header[8]=8; header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),
    chunk("IDAT",deflateSync(Buffer.from([0,value,22,33]))),chunk("IEND",Buffer.alloc(0))]);
}

function glb(): Buffer {
  const json = Buffer.from('{"asset":{"version":"2.0"}} ');
  const header = Buffer.alloc(20); header.write("glTF"); header.writeUInt32LE(2,4);
  header.writeUInt32LE(20+json.length,8); header.writeUInt32LE(json.length,12); header.writeUInt32LE(0x4e4f534a,16);
  return Buffer.concat([header,json]);
}

function seed(id:string, managed=false) {
  const root = join(process.env.WB_DATA_DIR!,"mockups",id); mkdirSync(join(root,"assets"),{recursive:true});
  const files = [["white_a","front_right_white.png"],["white_b","back_left_white.png"],["glb","box.glb"],
    ["white_a_ground","front_right_ground.png"],["white_a_card","front_right_card.png"]].map(([key,name]) => {
      const path = join(root,name); writeFileSync(path,key === "glb" ? glb() : png()); return {key,name,path};
    });
  for (const face of ["front","right","back","left","top","bottom"]) writeFileSync(join(root,"assets",`panel_${face}.png`),png());
  saveMockup({id,owner:owner.open_id,created_at:"2026-09-06T00:00:00Z",status:"done",job_kind:"mockup",job_status:"succeeded",files});
  const store = openRenderGenerationStore({jobId:id,jobRoot:root,qualityVerifier:input => ({...input,
    verifier_status:"accepted",quality_status:"unwired",verifier:"synthetic-store-test",note:"not visual acceptance"})});
  const virtual = store.virtualLegacyCurrentId();
  if (managed) {
    const sealed = store.sealGeneration({mode:"legacy_import",contractSha256:contractSha,contractBytes:contract,
      profile:"compat-legacy-v0",observedCurrentGenerationId:null,expectedCurrentGenerationId:virtual,actorLabel:"合成作者"});
    saveMockup(applyRenderGenerationPatch(readMockupFromDisk(id)!,sealed.patch));
  }
  return {id,root,store,virtual};
}

function request(path:string,session=reader,headers:Record<string,string>={}) {
  return app.request(path,{headers:{authorization:`Bearer ${session.token}`,...headers}});
}
function post(path:string,body:unknown,session=owner) {
  return app.request(path,{method:"POST",headers:{authorization:`Bearer ${session.token}`,"content-type":"application/json"},body:JSON.stringify(body)});
}
function tree(root:string): Record<string,string> {
  const out: Record<string,string> = {};
  const walk = (path:string) => { for(const entry of readdirSync(path,{withFileTypes:true})) {
    const child = join(path,entry.name); if(entry.isDirectory()) walk(child);
    else out[child] = createHash("sha256").update(readFileSync(child)).digest("hex");
  }};
  walk(root); return out;
}

it("RF-04 details/history/files are shared read, contain no private paths, and never write", async () => {
  const f=seed("f00400000001"); const before=tree(f.root);
  for (const session of [reader,owner,admin,stranger]) {
    const detail=await request(`/api/mockups/${f.id}`,session); assert.equal(detail.status,200);
    const body=await detail.json(); assert.equal(body.current_render_generation_id,f.virtual);
    assert.equal(body.render_generation_capabilities.history.allowed,true);
    assert.equal(body.render_generation_capabilities.legacy_relight.allowed,false);
    assert.equal(body.render_generation_capabilities.legacy_relight.reason,
      session === reader || session === stranger ? "permission_denied" : "production_registration_disabled");
    assert.doesNotMatch(JSON.stringify(body),/\.render-generations|worker_pid|worker_execution_id|payload_sha256/);
    const history=await request(`/api/mockups/${f.id}/render-generations`,session);
    assert.deepEqual(await history.json(),{items:[],next_cursor:null});
    const file=await request(`/api/mockups/${f.id}/files/white_a?generation_id=${f.virtual}`,session);
    assert.equal(file.status,200); assert.deepEqual(Buffer.from(await file.arrayBuffer()),png());
  }
  assert.deepEqual(tree(f.root),before);
  assert.equal((await app.request(`/api/mockups/${f.id}/render-generations`)).status,401);
});

it("RF-04 per-action permissions preserve history/activation independently of runtime", async () => {
  const f=seed("f00400000002",true);
  for(const session of [reader,owner,admin,stranger]) {
    const body=await (await request(`/api/mockups/${f.id}`,session)).json();
    assert.equal(body.render_generation_capabilities.activate.allowed,session === owner || session === admin);
    assert.equal(body.render_generation_capabilities.legacy_relight.allowed,false);
    const history=await (await request(`/api/mockups/${f.id}/render-generations`,session)).json();
    assert.equal(history.items.length,1); assert.equal(history.items[0].current,true);
  }
});

it("RF-04 write endpoints enforce fresh ownership/schema/mode/CAS without enabling production", async () => {
  const f=seed("f00400000007",true);
  const base=`/api/mockups/${f.id}/render-generations`;
  const body={client_request_id:"rf04-request-001",mode:"legacy_relight",source_generation_id:"g0-legacy-original",expected_current_generation_id:"g0-legacy-original"};
  assert.equal((await post(base,body,reader)).status,403);
  assert.equal((await post(base,body,stranger)).status,403);
  const disabled=await post(base,body); assert.equal(disabled.status,412);
  assert.equal((await disabled.json()).reason,"production_registration_disabled");
  const upgrade=await post(base,{...body,mode:"upgrade"}); assert.equal(upgrade.status,412);
  assert.equal((await upgrade.json()).reason,"upgrade_unwired");
  for(const bad of [{...body,actor:"fake"},{...body,profile:"fake"},{...body,client_request_id:123},null,[]]) {
    const result=await post(base,bad); assert.equal(result.status,400); assert.equal((await result.json()).reason,"payload_invalid");
  }
  const activate=base+"/g0-legacy-original/activate";
  assert.equal((await post(activate,{expected_current_generation_id:"g0-legacy-original"},reader)).status,403);
  assert.equal((await post(activate,{expected_current_generation_id:"g0-legacy-original"},stranger)).status,403);
  assert.equal((await post(activate,{expected_current_generation_id:"g0-legacy-original"},admin)).status,200);
  const stale=await post(activate,{expected_current_generation_id:f.virtual}); assert.equal(stale.status,409);
  assert.equal((await stale.json()).reason,"current_changed");
  assert.equal((await post(base+"/g1-legacy-relight-00000000-00000000/activate",{expected_current_generation_id:"g0-legacy-original"})).status,404);
  const before=tree(f.root);
  const compatibility=await post(`/api/mockups/${f.id}/relight`,{}); assert.equal(compatibility.status,412);
  assert.equal((await compatibility.json()).reason,"production_registration_disabled");
  assert.deepEqual(tree(f.root),before,"disabled compatibility must not write old root");
});

it("RF-04 capability rejects unavailable or changed sources without writes or blocking history", {skip:process.platform === "win32"}, async () => {
  const f=seed("f00400000020",true);
  const plan=join(f.root,"resolved_job.json");
  const assets=Object.fromEntries(["front","right","back","left","top","bottom"].map(face=>[face,join(f.root,"assets",`panel_${face}.png`)]));
  const clear=registerLocalRenderGenerationRuntime({pythonExecutable:process.execPath,blenderExecutable:process.execPath,
    packagingDir:f.root,dataRoot:process.env.WB_DATA_DIR!});
  const capabilities=async()=>{
    const before=tree(f.root);
    const body=await (await request(`/api/mockups/${f.id}`,owner)).json();
    assert.deepEqual(tree(f.root),before,"capability GET must never repair, archive or spawn");
    assert.equal(body.render_generation_capabilities.history.allowed,true);
    assert.equal(body.render_generation_capabilities.activate.allowed,true);
    return body.render_generation_capabilities.legacy_relight;
  };
  try {
    assert.deepEqual(await capabilities(),{allowed:false,reason:"source_changed"});
    for (const text of ["{",JSON.stringify({assets:{...assets,front:"/outside/source.png"}}),JSON.stringify({assets:{}})]) {
      writeFileSync(plan,text);
      assert.deepEqual(await capabilities(),{allowed:false,reason:"source_changed"});
    }
    writeFileSync(plan,JSON.stringify({assets}));
    assert.deepEqual(await capabilities(),{allowed:true});
    writeFileSync(assets.front,png(99));
    assert.deepEqual(await capabilities(),{allowed:false,reason:"source_changed"});
    writeFileSync(assets.front,png());
    assert.deepEqual(await capabilities(),{allowed:true});
    unlinkSync(assets.bottom);
    assert.deepEqual(await capabilities(),{allowed:false,reason:"source_changed"});
    const readerCaps=(await (await request(`/api/mockups/${f.id}`,reader)).json()).render_generation_capabilities;
    assert.equal(readerCaps.legacy_relight.reason,"permission_denied","permission precedes source details");
  } finally { clear(); }
});

it("RF-04 body parser accepts exactly 4096 bytes and rejects oversized or malformed JSON without writes", async () => {
  const f=seed("f00400000021",true);
  const path=`/api/mockups/${f.id}/render-generations/g0-legacy-original/activate`;
  const json=JSON.stringify({expected_current_generation_id:"g0-legacy-original"});
  const before=tree(f.root);
  for (const [body,status] of [[json.padEnd(4096," "),200],[json.padEnd(4097," "),400],["{",400]] as const) {
    const result=await app.request(path,{method:"POST",headers:{authorization:`Bearer ${owner.token}`,"content-type":"application/json"},body});
    assert.equal(result.status,status);
    if(status===400) assert.equal((await result.json()).reason,"payload_invalid");
    assert.deepEqual(tree(f.root),before);
  }
});

it("RF-04 failed idempotent responses use the same sanitized mutation as detail without changing private evidence", async () => {
  const f=seed("f00400000022",true);
  const input={client_request_id:"rf04-failed-replay",mode:"legacy_relight",source_generation_id:"g0-legacy-original",expected_current_generation_id:"g0-legacy-original"};
  const payload=createHash("sha256").update(JSON.stringify({mode:input.mode,source_generation_id:input.source_generation_id,studio_adjustment:null})).digest("hex");
  for (const error of ["ENOENT: open '/private/internal/artwork/secret.png'","EACCES: open C:\\Private\\artwork\\secret.png"]) {
    const mutation={id:"m0000000000000022",mode:"legacy_relight" as const,status:"failed" as const,stage:"保存成片",error};
    saveMockup({...readMockupFromDisk(f.id)!,render_mutation:mutation,
      render_generation_idempotency:[{client_request_id:input.client_request_id,payload_sha256:payload,mutation}]});
    const before=tree(f.root);
    const detail=await (await request(`/api/mockups/${f.id}`,owner)).json();
    const replay=await post(`/api/mockups/${f.id}/render-generations`,input);
    assert.equal(replay.status,202);
    const result=await replay.json();
    assert.deepEqual(result.mutation,detail.render_mutation);
    assert.equal(result.mutation.status,"failed");
    assert.doesNotMatch(JSON.stringify(result),/private|artwork|secret\.png/i);
    assert.equal(readMockupFromDisk(f.id)!.render_generation_idempotency![0].mutation.error,error);
    assert.deepEqual(tree(f.root),before,"replay must not rewrite private evidence or enqueue work");
  }
});

it("RF-04 HTTP traverses the ordinary local registry, owned child, seal, activation and read-only history without jobs hooks", {skip:process.platform === "win32"}, async () => {
  // Controlled child protocol + valid synthetic containers only. Not real RF-02/Blender/L2 evidence.
  resetJobsTestHooks();
  const f=seed("f00400000008");
  const assets=Object.fromEntries(["front","right","back","left","top","bottom"].map(face=>[face,join(f.root,"assets",`panel_${face}.png`)]));
  writeFileSync(join(f.root,"resolved_job.json"),JSON.stringify({assets}));
  const workerRoot=makeTestTempDir("beian-rf04-protocol-");
  writeFileSync(join(workerRoot,"render_generation.py"),String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>body+=v);
process.stdin.on('end',()=>{
 const req=JSON.parse(body),hash=b=>'sha256:'+crypto.createHash('sha256').update(b).digest('hex');
 const plan=hash('synthetic-plan');
 const result={ok:true,schema:'packaging-render-generation-result/1',action:req.action,mode:req.mode,
  source_identity:{resolved_job_sha256:req.expected_source_sha256,plan_identity:plan,render_contract_hash:hash('contract'),render_profile_id:'synthetic-only',assets:req.expected_asset_sha256},
  candidate_plan_identity:plan,candidate_identity:hash('candidate'),candidate_dir:req.candidate_dir||null,
  studio_adjustment:req.studio_adjustment||null,execution:{status:'validated',nonce:null},outputs:{},optional_warnings:[],
  quality:{status:'unwired',wired:false,runtime_gate:'pending',production_ready:false}};
 if(req.action==='render-candidate'){
  fs.mkdirSync(req.candidate_dir);
  for(const key of ['front_right','back_left','front_right_card','back_left_card','glb']){
   const bytes=fs.readFileSync(path.join(req.job_root,key==='glb'?'box.glb':'front_right_white.png'));
   const file=path.join(req.candidate_dir,key+(key==='glb'?'.glb':'.png'));fs.writeFileSync(file,bytes);
   result.outputs[key]={path:file,sha256:hash(bytes),bytes:bytes.length};
  }
  result.execution={status:'rendered',nonce:'0123456789abcdef0123456789abcdef'};
  result.artifact_checks={glb:'passed',full_card:'passed',source_sampling:'passed'};
 }
 process.stderr.write('STAGE validate\n');console.log(JSON.stringify(result));
});`);
  const clear=registerLocalRenderGenerationRuntime({pythonExecutable:process.execPath,blenderExecutable:process.execPath,
    packagingDir:workerRoot,dataRoot:process.env.WB_DATA_DIR!,timeoutMs:10_000,terminationGraceMs:200});
  try {
    assert.equal(getRenderGenerationRuntime()?.productionEnabled,false);
    const base=`/api/mockups/${f.id}/render-generations`;
    const input={client_request_id:"rf04-ordinary-registry",mode:"legacy_relight",source_generation_id:f.virtual,
      expected_current_generation_id:f.virtual,studio_adjustment:{product_light:1,background_light:1}};
    const accepted=await post(base,input);assert.equal(accepted.status,202);const first=await accepted.json();
    assert.equal(first.job_status,"done");
    assert.equal((await post(base,{...input,studio_adjustment:{product_light:1.1,background_light:1}})).status,409);
    const replay=await post(base,input);assert.equal(replay.status,202);assert.equal((await replay.json()).mutation.id,first.mutation.id);
    for(let i=0;i<200 && !["succeeded","failed"].includes(readMockupFromDisk(f.id)?.render_mutation?.status || "");i++) await delay(25);
    const job=readMockupFromDisk(f.id)!;
    assert.equal(job.render_mutation?.status,"succeeded",job.render_mutation?.error);
    assert.equal(job.render_last_activation?.mode,"legacy_relight");
    const current=job.current_render_generation_id!;
    const body=await (await request(`/api/mockups/${f.id}`,owner)).json();
    assert.equal(body.render_generation_capabilities.activate.allowed,true);
    assert.doesNotMatch(JSON.stringify(body),/render_last_activation|worker_pid|actor_id|execution_id/);
    const terminal=await (await post(base,input)).json(); assert.equal(terminal.mutation.status,"succeeded");
    const old=await post(base+"/g0-legacy-original/activate",{expected_current_generation_id:current});assert.equal(old.status,200);
    const stale=await post(base+`/${current}/activate`,{expected_current_generation_id:current});
    assert.equal(stale.status,409);assert.equal((await stale.json()).reason,"current_changed");
    clear();
    const history=await (await request(base)).json();assert.equal(history.items.length,2);
    const read=await request(`/api/mockups/${f.id}/files/white_a?generation_id=${current}&download=1`);
    assert.equal(read.status,200);assert.deepEqual(Buffer.from(await read.arrayBuffer()),png());
    assert.equal(getRenderGenerationRuntime(),undefined);
    await verifyReadOnlyRollback(f.id,f.root,current);
  } finally {clear();resetJobsTestHooks();}
});

async function verifyReadOnlyRollback(id:string,root:string,current:string) {
  const revision="e1c2d6794c3ba5cc35da15a41bd738a8692a95b0";
  const source=(file:string)=>execFileSync("git",["show",`${revision}:apps/web/server/src/${file}`],{encoding:"utf8"});
  const importTs=(text:string)=>import(`data:text/javascript;base64,${Buffer.from(transpileModule(text,
    {compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.ES2022}}).outputText).toString("base64")}`);
  const before=tree(root);
  // Execute the actual pinned old store, not a reimplementation of its parser.
  const oldStoreModule=await importTs(source("renderGenerations.ts"));
  const oldStore=oldStoreModule.openRenderGenerationStore({jobId:id,jobRoot:root});
  assert.throws(()=>oldStore.publicSummary(current,current),"old store cannot parse runtime_verified; do not claim history rollback works");
  assert.equal(oldStore.publicSummary("g0-legacy-original",current).quality_status,"unwired");
  // Transpile the pinned old fileOf and its complete local call closure verbatim.
  // The old directory helper is supplied a write-denying mkdir, so this is read-only by construction.
  const parsed=createSourceFile("mockup.ts",source("mockup.ts"),ScriptTarget.Latest,true,ScriptKind.TS);
  const wanted=new Set(["fileOf","underJobDir","mockupRoot","liveReadPanelFiles"]);
  const functions=parsed.statements.filter(node=>isFunctionDeclaration(node) && node.name && wanted.has(node.name.text));
  assert.equal(functions.length,wanted.size);
  const oldFiles=await importTs(`import {existsSync,realpathSync} from 'node:fs';
    import {join,relative,isAbsolute,resolve,basename} from 'node:path';
    const DATA_DIR=${JSON.stringify(process.env.WB_DATA_DIR)};
    function mkdirSync(){throw Error('rollback must never write');}
    ${functions.map(node=>node.getText(parsed)).join("\n")}`);
  const mirror=readMockupFromDisk(id)!;
  // Use the actual job.files mirror of the newer ready generation, not the legacy root.
  const patch=openRenderGenerationStore({jobId:id,jobRoot:root}).prepareActivationPatch({generationId:current,
    observedCurrentGenerationId:mirror.current_render_generation_id!,expectedCurrentGenerationId:mirror.current_render_generation_id!});
  const currentMirror={...mirror,...patch};
  for(const key of ["white_a","white_b","glb","white_a_card","white_b_card"]) {
    const file=oldFiles.fileOf(currentMirror,key) as {path:string};
    assert.ok(file.path.includes(current));
    const download=new Response(Readable.toWeb(createReadStream(file.path)) as ReadableStream);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),readFileSync(file.path));
  }
  assert.deepEqual(tree(root),before,"old code rollback reads never modify root/g0/ready/index/job");
}

it("RF-04 generation-bound assets reject ground/card-only changes and missing keys, never mix", async () => {
  const f=seed("f00400000003");
  writeFileSync(join(f.root,"front_right_ground.png"),png(44));
  const stale=await request(`/api/mockups/${f.id}/files/white_a?generation_id=${f.virtual}`);
  assert.equal(stale.status,409); assert.equal((await stale.json()).reason,"current_changed");
  const fresh=f.store.virtualLegacyCurrentId(); unlinkSync(join(f.root,"front_right_card.png"));
  assert.equal((await request(`/api/mockups/${f.id}/files/glb?generation_id=${fresh}`)).status,409);
  assert.equal((await request(`/api/mockups/${f.id}/files/white_a?generation_id=legacy-current-deadbeef`)).status,409);
  assert.equal((await request(`/api/mockups/${f.id}/files/read_front?generation_id=${f.store.virtualLegacyCurrentId()}`)).status,404);
});

it("RF-04 ready reads are immutable, ETag works, downloads return bytes, corrupt generations fail closed", async () => {
  const f=seed("f00400000004",true); const id="g0-legacy-original";
  const url=`/api/mockups/${f.id}/files/white_a?generation_id=${id}`;
  const first=await request(url); assert.equal(first.status,200); const etag=first.headers.get("etag")!;
  await first.arrayBuffer(); assert.equal((await request(url,reader,{"if-none-match":etag})).status,304);
  const download=await request(url+"&download=1",reader,{"if-none-match":etag}); assert.equal(download.status,200);
  assert.equal(download.headers.get("cache-control"),"private, no-store");
  assert.match(download.headers.get("content-disposition")!,/^attachment/); await download.arrayBuffer();
  const head=await app.request(url,{method:"HEAD",headers:{authorization:`Bearer ${reader.token}`}});
  assert.equal(head.status,200); assert.equal(head.headers.get("etag"),etag); assert.equal(await head.text(),"");
  const cancelled=await request(url); await cancelled.body!.cancel();
  const afterCancel=await request(url); assert.deepEqual(Buffer.from(await afterCancel.arrayBuffer()),png());
  const current=readMockupFromDisk(f.id)!; const path=current.files.find(row=>row.key === "white_a")!.path!;
  renameSync(path,path+".old"); writeFileSync(path,png(55));
  const corrupt=await request(`/api/mockups/${f.id}/files/glb?generation_id=${id}`);
  assert.equal(corrupt.status,409); assert.equal((await corrupt.json()).reason,"generation_corrupt");
});

it("RF-04 old in-place work cannot mint a root snapshot, and query/cross-job failures are bounded", async () => {
  const f=seed("f00400000005"); const job=readMockupFromDisk(f.id)!;
  beginStructureConfirmation(job);
  try {
    const body=await (await request(`/api/mockups/${f.id}`,owner)).json();
    assert.equal(body.current_render_generation_id,undefined);
    assert.equal(body.render_generation_capabilities.legacy_relight.reason,"mutation_busy");
    assert.equal((await request(`/api/mockups/${f.id}/files/white_a?generation_id=${f.virtual}`)).status,409);
  } finally { finishStructureConfirmation(f.id); }
  for (const query of ["limit=0","limit=51","cursor=","limit=1&limit=2","cursor=forged.value"]) {
    assert.equal((await request(`/api/mockups/${f.id}/render-generations?${query}`)).status,400);
  }
  const other=seed("f00400000006");
  assert.equal((await request(`/api/mockups/${other.id}/files/white_a?generation_id=${f.virtual}`)).status,409);
  assert.equal((await request(`/api/mockups/f004ffffffff/render-generations`)).status,404);
  const list=await (await request("/api/mockups")).json();
  assert.equal(list.find((row:{id:string})=>row.id === f.id).render_generation_capabilities,undefined);
});
