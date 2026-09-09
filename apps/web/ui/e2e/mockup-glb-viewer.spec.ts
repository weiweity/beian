import { carton } from "./fixtures/glbFixture";
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Built application, six textured synthetic faces, and intercepted URLs only. No listener or renderer.
let dist: string;
const assets = new Map<string, Buffer>();
const ID = 'af0200000001', GENERATION = 'legacy-current-v2-' + 'a'.repeat(64);
test.beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'beian-glb-viewer-'));
  execFileSync('npm', ['run', 'build', '--', '--outDir', dist], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 90_000, stdio: 'pipe',
  });
  for (const name of readdirSync(join(dist, 'assets'))) assets.set(`/assets/${name}`, readFileSync(join(dist, 'assets', name)));
});
test.afterAll(() => { if (dist) rmSync(dist, { recursive: true }); });

const source = carton();
async function serve(page: Page, fail = false, white = false) {
  await page.addInitScript(() => {
    const audit = { created: [] as string[], revoked: [] as string[] };
    Object.assign(window, { __blobAudit: audit });
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); audit.created.push(url); return url; };
    URL.revokeObjectURL = url => { audit.revoked.push(url); revoke(url); };
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const json = (body: unknown) => route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    if (!path.startsWith('/api/')) {
      const body = assets.get(path) || (path.startsWith('/mockup') ? readFileSync(join(dist,'index.html')) : null);
      return route.fulfill({status:body?200:404,body:body || 'synthetic missing',contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.hdr')?'application/octet-stream':'text/html'});
    }
    if (path === '/api/auth/me') return json({logged_in:true,display_name:'合成',open_id:'synthetic',role:'reviewer',perms:['read']});
    if (path === '/api/status' || path === '/api/health') return json({ok:true,version:'0.0.0.0',jobs:{}});
    if (path.endsWith('/files/glb')) return route.fulfill({status:fail?500:200,contentType:'model/gltf-binary',body:fail?'failed':white?carton(true):source});
    if (path.includes('/files/')) return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect width="80" height="96" fill="white"/></svg>'});
    if (path === `/api/mockups/${ID}`) return json({id:ID,title:'SYNTHETIC GLB',status:'done',owner:'synthetic',current_render_generation_id:GENERATION,
      files:['glb','white_a','white_b','white_a_ground','white_b_ground','white_a_set','white_b_set'].map(key=>({key,name:key}))});
    if (path.endsWith('/render-generations')) return json({items:[],next_cursor:null});
    return json([]);
  });
}
async function loaded(page: Page) {
  await expect(page.getByRole('button',{name:'复位模型视角'})).toBeEnabled();
  await expect.poll(() => page.locator('model-viewer').evaluate((el:any) => el.loaded)).toBe(true);
}
async function orbit(page: Page) {
  return page.locator('model-viewer').evaluate((el:any) => { const o=el.getCameraOrbit(); return {theta:o.theta*180/Math.PI,phi:o.phi*180/Math.PI,radius:o.radius,fov:el.getFieldOfView()}; });
}

test('桌墙显示资源保持原始下载并可复位，离页释放 blob', async ({page}) => {
  test.setTimeout(45_000);
  await serve(page); await page.goto(`/mockup/${ID}`); await loaded(page);
  await page.locator('.mockup-backdrop-switch').getByText('白底',{exact:true}).click(); await loaded(page);
  const initial = await orbit(page); expect(initial.theta).toBeCloseTo(35,1); expect(initial.phi).toBeCloseTo(72,1);
  const link = page.getByRole('link',{name:'下载 GLB',exact:true}); const href = await link.getAttribute('href');
  await page.locator('.mockup-backdrop-switch').getByText('白桌白墙',{exact:true}).click(); await loaded(page);
  await expect(page.locator('model-viewer')).toHaveAttribute('src',/^blob:/);
  const sceneUrl = await page.locator('model-viewer').getAttribute('src');
  await page.locator('.mockup-sheet-glb').screenshot({path:test.info().outputPath('textured-carton-room.png')});
  await expect(link).toHaveAttribute('href',href!);
  const bytes = await page.evaluate(async url => [...new Uint8Array(await (await fetch(url)).arrayBuffer())],href!);
  expect(Buffer.from(bytes)).toEqual(source);
  await page.getByRole('button',{name:'复位模型视角'}).click();
  await expect.poll(async()=>Math.round((await orbit(page)).theta)).toBe(35);
  await expect.poll(async()=>Math.round((await orbit(page)).phi)).toBe(72);
  await page.getByRole('button',{name:'全屏截图',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>Boolean(document.fullscreenElement))).toBe(true);
  await loaded(page);await expect(page.locator('.mockup-sheet-glb a[download]')).toHaveAttribute('href',href!);
  await page.evaluate(()=>document.exitFullscreen());await loaded(page);
  await page.getByRole('button',{name:'返回打样台',exact:true}).click();
  await expect.poll(()=>page.evaluate(url=>(window as any).__blobAudit.revoked.includes(url),sceneUrl)).toBe(true);
});

test('GLB 请求失败明确显示错误而保留原始下载',async ({page}) => {
  await serve(page,true);await page.goto(`/mockup/${ID}`);
  await expect(page.getByRole('alert').filter({hasText:'3D 预览加载失败'})).toBeVisible();
  await expect(page.getByRole('link',{name:'下载 GLB',exact:true})).toHaveAttribute('href',new RegExp(`generation_id=${GENERATION}`));
  await expect(page.getByRole('button',{name:'复位模型视角'})).toBeDisabled();
});


test('用户旋转缩放后切背景保持轨道',async ({page})=>{
  await serve(page);await page.goto(`/mockup/${ID}`);await loaded(page);
  await page.locator('.mockup-backdrop-switch').getByText('白底',{exact:true}).click();await loaded(page);
  await page.locator('model-viewer').evaluate(async (el:any)=>{
    el.setAttribute('camera-orbit',`65deg 80deg ${el.getCameraOrbit().radius*.85}m`);
    await el.updateComplete;el.jumpCameraToGoal();
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    el.dispatchEvent(new CustomEvent('camera-change',{detail:{source:'user-interaction'}}));
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
  });
  const moved=await orbit(page);
  await page.locator('.mockup-backdrop-switch').getByText('白桌白墙',{exact:true}).click();await loaded(page);
  const after=await orbit(page);expect(after.theta).toBeCloseTo(moved.theta,1);expect(after.phi).toBeCloseTo(moved.phi,1);
  expect(after.radius*Math.sin(after.fov*Math.PI/360)/(moved.radius*Math.sin(moved.fov*Math.PI/360))).toBeCloseTo(1,1);
});

test('已加载显示场景报错立即释放blob',async({page})=>{
  await serve(page);await page.goto(`/mockup/${ID}`);await loaded(page);
  await page.locator('.mockup-backdrop-switch').getByText('白桌白墙',{exact:true}).click();await loaded(page);
  const sceneUrl=await page.locator('model-viewer').getAttribute('src');expect(sceneUrl).toMatch(/^blob:/);
  await page.locator('model-viewer').dispatchEvent('error');
  await expect(page.getByRole('alert').filter({hasText:'3D 预览加载失败'})).toBeVisible();
  await expect.poll(()=>page.evaluate(url=>(window as any).__blobAudit.revoked.includes(url),sceneUrl)).toBe(true);
});

test('真实指针拖动可旋转模型',async({page})=>{
  await serve(page);await page.goto(`/mockup/${ID}`);await loaded(page);
  await page.locator('model-viewer').scrollIntoViewIfNeeded();
  const before=await orbit(page),b=(await page.locator('model-viewer').boundingBox())!;
  await page.mouse.move(b.x+b.width*.45,b.y+b.height*.5);await page.mouse.down();
  for(let i=1;i<=12;i++){
    await page.mouse.move(b.x+b.width*(.45+i*.02),b.y+b.height*.5);
    await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>r())));
  }
  await page.mouse.up();
  await expect.poll(async()=>Math.abs((await orbit(page)).theta-before.theta)).toBeGreaterThan(5);
});

test('产品灯变化保留桌墙背景亮度并改变盒身',async({page})=>{
  await serve(page);await page.goto(`/mockup/${ID}`);await loaded(page);
  await page.locator('.mockup-backdrop-switch').getByText('白桌白墙',{exact:true}).click();await loaded(page);
  const frame=page.locator('.mockup-sheet-glb'),src=await page.locator('model-viewer').getAttribute('src');
  async function pixels(){
    return page.evaluate(async bytes=>{
      const bmp=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));
      const c=new OffscreenCanvas(bmp.width,bmp.height),ctx=c.getContext('2d')!;ctx.drawImage(bmp,0,0);
      const pixel=(x:number,y:number)=>[...ctx.getImageData(Math.round(bmp.width*x),Math.round(bmp.height*y),1,1).data].slice(0,3);
      const result={background:pixel(.08,.45),box:pixel(.5,.45)};bmp.close();return result;
    },[...await frame.screenshot()]);
  }
  const before=await pixels();
  await page.getByRole('button',{name:'调灯',exact:true}).click();
  await page.getByRole('slider',{name:'产品灯光',exact:true}).fill('1.3');
  await expect(page.locator('model-viewer')).toHaveAttribute('exposure','0.91');
  await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
  const after=await pixels();
  expect(Math.max(...after.background.map((v,i)=>Math.abs(v-before.background[i])))).toBeLessThanOrEqual(2);
  expect(Math.max(...after.box.map((v,i)=>Math.abs(v-before.box[i])))).toBeGreaterThan(2);
  await expect(page.locator('model-viewer')).toHaveAttribute('src',src!);
});


test('白盒三种背景展示证据',async({page})=>{
  await serve(page,false,true);await page.goto(`/mockup/${ID}`);await loaded(page);
  for(const [name,file] of [['白底','white'],['银底','silver'],['白桌白墙','room']]){
    await page.locator('.mockup-backdrop-switch').getByText(name,{exact:true}).click();await loaded(page);
    await page.locator('.mockup-sheet-glb').screenshot({path:process.env.GLB_EVIDENCE_DIR ? join(process.env.GLB_EVIDENCE_DIR,`white-carton-${file}.png`) : test.info().outputPath(`white-carton-${file}.png`)});
  }
});

test('近墙在八个方位不遮挡包装，背面可查看', async ({page}) => {
  test.setTimeout(45_000);
  await serve(page); await page.goto(`/mockup/${ID}`); await loaded(page);
  await page.locator('.mockup-backdrop-switch').getByText('白桌白墙',{exact:true}).click(); await loaded(page);
  const viewer=page.locator('model-viewer');
  for (const theta of [0,45,90,135,180,225,270,315]) {
    await viewer.evaluate(async (el:any, angle:number) => {
      el.setAttribute('camera-orbit', `${angle}deg 72deg ${el.getCameraOrbit().radius}m`);
      await el.updateComplete; el.jumpCameraToGoal();
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    }, theta);
    const pixels=await page.evaluate(async bytes=>{
      const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d')!;
      ctx.drawImage(bitmap,0,0);
      const rgb=[...ctx.getImageData(Math.floor(bitmap.width/2),Math.floor(bitmap.height/2),1,1).data].slice(0,3);
      bitmap.close();return rgb;
    }, [...await viewer.screenshot()]);
    expect(Math.max(...pixels)-Math.min(...pixels), `box remains visible at ${theta}deg`).toBeGreaterThan(8);
    if (theta===180 && process.env.GLB_EVIDENCE_DIR) {
      await page.locator('.mockup-sheet-glb').screenshot({path:join(process.env.GLB_EVIDENCE_DIR,'close-wall-rear.png')});
    }
  }
});
