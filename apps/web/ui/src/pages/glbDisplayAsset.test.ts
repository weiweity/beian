import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeGlbDisplaySet, DISPLAY_TABLE_MATERIAL, DISPLAY_WALL_MATERIAL, DISPLAY_CONTACT_MATERIAL } from './glbDisplayAsset';

function fixture(edit: (doc: any) => void = () => {}) {
  const bin = new Uint8Array(64).map((_, i) => i * 3);
  const doc = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ translation: [0, 2, 0], children: [1] }, { mesh: 0, name: 'front', scale: [2, 1, 3] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    accessors: [{ type: 'VEC3', min: [-1,-1,-1], max: [1,1,1] }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    images: [{ bufferView: 0, mimeType: 'image/png' }], textures: [{ source: 0 }],
    materials: [{ name: 'print', alphaMode: 'MASK', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, roughnessFactor: 0.52 } }] };
  edit(doc);
  const json = new TextEncoder().encode(JSON.stringify(doc)), length = Math.ceil(json.length / 4)*4;
  const bytes = new Uint8Array(28 + length + bin.length), view = new DataView(bytes.buffer);
  [0x46546c67,2,bytes.length,length,0x4e4f534a].forEach((v,i)=>view.setUint32(i*4,v,true));
  bytes.fill(32,20,20+length); bytes.set(json,20);
  view.setUint32(20+length,bin.length,true); view.setUint32(24+length,0x004e4942,true); bytes.set(bin,28+length);
  return { bytes, doc, bin };
}
function decode(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), len = view.getUint32(12,true);
  return { doc: JSON.parse(new TextDecoder().decode(bytes.subarray(20,20+len))), bin: bytes.subarray(28+len) };
}
test('preserves original packaging materials, texture references, nodes and every binary byte', () => {
  const input = fixture(), before = input.bytes.slice(), result = composeGlbDisplaySet(input.bytes), parsed = decode(result.bytes);
  assert.deepEqual(input.bytes,before);
  assert.deepEqual(parsed.bin.subarray(0,input.bin.length),input.bin);
  for(const key of ['images','textures']) assert.deepEqual(parsed.doc[key].slice(0,1), (input.doc as any)[key]);
  assert.deepEqual(parsed.doc.materials.slice(0,1),input.doc.materials);
  assert.deepEqual(parsed.doc.nodes.slice(0,2),input.doc.nodes);
  assert.deepEqual(parsed.doc.meshes.slice(0,1),input.doc.meshes);
  assert.equal(parsed.doc.scenes[0].nodes.length,2);
  assert.deepEqual(result.bounds.min,[-2,1,-3]); assert.deepEqual(result.bounds.max,[2,3,3]);
});
test('world bounds include parent rotation and child matrix', () => {
  const {bytes}=fixture(d=>{d.nodes[0].rotation=[0,0,Math.SQRT1_2,Math.SQRT1_2]; d.nodes[1]={ mesh:0,matrix:[1,0,0,0,0,1,0,0,0,0,1,0,3,0,0,1] };});
  const {bounds}=composeGlbDisplaySet(bytes);
  bounds.center.forEach((v,i)=>assert.ok(Math.abs(v-[0,5,0][i])<1e-10));
});
test('uses active scene only, no unused mesh pollution', () => {
  const {bytes}=fixture(d=>{d.scenes.push({nodes:[2]});d.nodes.push({mesh:0,translation:[1000,0,0]});});
  assert.deepEqual(composeGlbDisplaySet(bytes).bounds.center,[0,2,0]);
});
test('supports sliced byte arrays without assuming zero byteOffset',()=>{
  const {bytes}=fixture(), padded = new Uint8Array(bytes.length+10); padded.set(bytes,5);
  assert.deepEqual(composeGlbDisplaySet(padded.subarray(5,5+bytes.length)).bounds.center,[0,2,0]);
});
test('background light changes only appended material, in linear space',()=>{
  const {bytes}=fixture(), a=decode(composeGlbDisplaySet(bytes,1).bytes),b=decode(composeGlbDisplaySet(bytes,0.6).bytes);
  assert.deepEqual(a.doc.materials[0],b.doc.materials[0]);
  const color=a.doc.materials[2].emissiveFactor;
  assert.ok(Math.abs(color[0]-0.8549926)<1e-6);
  assert.ok(b.doc.materials[2].emissiveFactor[0]<color[0]);
});
for (const [name, edit] of Object.entries({
  'external buffer': (d:any): unknown =>d.buffers[0].uri='secret.bin',
  'external image': (d:any): unknown =>d.images[0].uri='https://example.com/image.png',
  'missing bounds': (d:any): unknown =>delete d.accessors[0].min,
  'inverted bounds': (d:any): unknown =>d.accessors[0].min=[2,2,2],
  'cycle': (d:any): unknown =>d.nodes[1].children=[0],
  'bad view': (d:any): unknown =>d.bufferViews[0].byteLength=10000,
  'skin': (d:any): unknown =>d.nodes[1].skin=0,
  'nonfinite transform': (d:any): unknown =>d.nodes[0].translation=[null,0,0],
})) test(`rejects ${name}`,()=>assert.throws(()=>composeGlbDisplaySet(fixture(edit).bytes)));
test('rejects bad version and truncated chunks',()=>{
  const {bytes}=fixture(); const bad=bytes.slice(); new DataView(bad.buffer).setUint32(4,1,true);
  assert.throws(()=>composeGlbDisplaySet(bad)); assert.throws(()=>composeGlbDisplaySet(bytes.subarray(0,bytes.length-1)));
});

test('table and walls have independent emissive materials and preserve extension declarations',()=>{
  const {bytes}=fixture(d=>{d.extensionsUsed=['KHR_materials_specular', 'KHR_texture_transform'];});
  const {doc}=decode(composeGlbDisplaySet(bytes).bytes);
  assert.equal(doc.materials[1].name,DISPLAY_TABLE_MATERIAL);
  assert.equal(doc.materials[2].name,DISPLAY_WALL_MATERIAL);
  assert.ok(doc.materials[1].emissiveFactor[0]<doc.materials[2].emissiveFactor[0]);
  for (const material of doc.materials.slice(1,3)) {
    assert.deepEqual(material.pbrMetallicRoughness.baseColorFactor,[0,0,0,1]);
    assert.equal(material.extensions.KHR_materials_specular.specularFactor,0);
    assert.equal(material.extensions.KHR_materials_emissive_strength.emissiveStrength,1);
  }
  assert.deepEqual(doc.extensionsUsed,['KHR_materials_specular','KHR_texture_transform','KHR_materials_emissive_strength','KHR_materials_unlit']);
  const primitives=doc.meshes[1].primitives;
  assert.deepEqual(primitives.map((p:any)=>p.material),[1,2,3]);
  assert.deepEqual(primitives.map((p:any)=>doc.accessors[p.attributes.POSITION].count),[6,6,6]);
  assert.equal(doc.accessors[primitives[1].attributes.POSITION].byteOffset,72);
});

test('contact approximation is textured, between floor and box, and leaves product bytes intact',()=>{
  const input=fixture(), {bytes,bounds}=composeGlbDisplaySet(input.bytes),{doc,bin}=decode(bytes);
  const shadow=doc.materials[3];
  assert.equal(shadow.name,DISPLAY_CONTACT_MATERIAL);
  assert.equal(shadow.alphaMode,'BLEND'); assert.deepEqual(shadow.extensions.KHR_materials_unlit,{});
  assert.match(doc.images[doc.textures[shadow.pbrMetallicRoughness.baseColorTexture.index].source].uri,/^data:image\/png;base64,/);
  const primitive=doc.meshes[1].primitives[2], position=doc.accessors[primitive.attributes.POSITION];
  const floor=doc.accessors[doc.meshes[1].primitives[0].attributes.POSITION].min[1];
  assert.ok(position.min[1]>floor); assert.ok(position.max[1]<bounds.min[1]);
  assert.ok(position.min[0]<bounds.min[0]);assert.ok(position.max[2]>bounds.max[2]);
  assert.equal(doc.accessors[primitive.attributes.TEXCOORD_0].type,'VEC2');
  assert.deepEqual(bin.subarray(0,input.bin.length),input.bin);
});

test('close wall meets the floor just behind the box and is invisible from its back', () => {
  const input=fixture(), {bytes,bounds}=composeGlbDisplaySet(input.bytes),{doc}=decode(bytes);
  const primitives=doc.meshes[1].primitives;
  const wall=doc.accessors[primitives[1].attributes.POSITION];
  const floor=doc.accessors[primitives[0].attributes.POSITION];
  assert.equal(wall.min[1],floor.min[1]);
  assert.equal(wall.min[2],wall.max[2]);
  assert.ok(wall.max[2]<bounds.min[2]);
  assert.ok(bounds.min[2]-wall.max[2]<bounds.size[2]*.2);
  assert.equal(doc.materials[primitives[1].material].doubleSided,false);
});
