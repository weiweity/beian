import assert from "node:assert/strict";
import { it } from "node:test";
import { createRenderRequest, readPendingRenderRequest, savePendingRenderRequest, renderCapabilityCopy,
  renderMutationLine, renderVersionLabel } from "./mockupRenderVersions.js";
import { studioAssetHref } from "./mockupStudio.js";

it("one click freezes ID/current/lights, and session restore never allocates or resubmits", () => {
  const data=new Map<string,string>();
  const storage={getItem:(key:string)=>data.get(key) ?? null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};
  const current="g1-legacy-relight-12345678-abcdef12";
  const request=createRenderRequest(current,1.2,0.8,"rf04-fixed-request");
  savePendingRenderRequest("aaaaaaaaaaaa",{request},storage);
  assert.deepEqual(readPendingRenderRequest("aaaaaaaaaaaa",storage),{request});
  assert.equal(readPendingRenderRequest("bbbbbbbbbbbb",storage),null);
  assert.equal(request.expected_current_generation_id,current);
  assert.equal(request.source_generation_id,current);
  assert.deepEqual(request.studio_adjustment,{product_light:1.2,background_light:0.8});
  savePendingRenderRequest("aaaaaaaaaaaa",null,storage);
  assert.equal(readPendingRenderRequest("aaaaaaaaaaaa",storage),null);
  storage.setItem("wb_render_request:aaaaaaaaaaaa",JSON.stringify({request:{...request,actor:"fake"}}));
  assert.equal(readPendingRenderRequest("aaaaaaaaaaaa",storage),null);
  assert.throws(()=>savePendingRenderRequest("aaaaaaaaaaaa",{request},{...storage,setItem:()=>{throw Error("quota");}}));
});

it("resource URLs bind every still layer/card/full/GLB/download to one public generation", () => {
  const generation="legacy-current-v2-"+"a".repeat(64);
  for (const key of ["white_a","white_b","white_a_card","white_a_ground","white_a_set","white_a_ground_card","glb"]) {
    for(const download of [true,false]) {
      const url=new URL(studioAssetHref("aaaaaaaaaaaa",key,generation,download),"http://local");
      assert.equal(url.searchParams.get("generation_id"),generation);
      assert.equal(url.searchParams.get("download"),download ? "1" : null);
    }
  }
});

it("version copy distinguishes runtime checking from visual acceptance and keeps old images on failure", () => {
  assert.equal(renderVersionLabel({mode:"legacy_import",quality_status:"unwired"}),"原图存档 · 未补验");
  assert.match(renderVersionLabel({mode:"legacy_relight",quality_status:"runtime_verified"}),/产物校验完成/);
  assert.doesNotMatch(renderVersionLabel({mode:"legacy_relight",quality_status:"runtime_verified"}),/画质验收|通过验收/);
  assert.match(renderMutationLine({id:"m1",mode:"legacy_relight",status:"running",stage:"出图"}),/当前图片仍可用/);
  assert.match(renderMutationLine({id:"m1",mode:"legacy_relight",status:"failed"}),/当前图片未变/);
  assert.match(renderCapabilityCopy("idempotency_capacity"),/历史仍可查看/);
});
