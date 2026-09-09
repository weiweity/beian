/** Adds display-only scenery without rebuilding the packaging mesh or its textures. */
type Vec = number[];
type Node = { matrix?: Vec; translation?: Vec; rotation?: Vec; scale?: Vec; mesh?: number; children?: number[]; skin?: number; weights?: Vec; name?: string };
type Accessor = { min?: Vec; max?: Vec; type?: string; componentType?: number; count?: number; bufferView?: number; byteOffset?: number };
type Primitive = { attributes: Record<string, number>; targets?: unknown[]; material?: number };
type Document = {
  asset: { version: string }; scene?: number; scenes: { nodes?: number[] }[]; nodes: Node[];
  meshes: { primitives: Primitive[]; name?: string }[]; accessors: Accessor[];
  buffers: { byteLength: number; uri?: string }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; target?: number }[];
  images?: { uri?: string }[]; textures?: { source: number }[]; materials?: unknown[]; extensionsUsed?: string[];
};
export const DISPLAY_TABLE_MATERIAL = 'Beian display table';
export const DISPLAY_WALL_MATERIAL = 'Beian display wall';
export const DISPLAY_CONTACT_MATERIAL = 'Beian display contact approximation';
// Synthetic 64x64 RGBA rectangular Gaussian; an approximate contact cue, not a light projection.
const CONTACT_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAD0klEQVR42u2ba08iQRBF9+kqyKooCoKgs4IBQUURH6Aruurq//9B2ySnksqk5wGMYnZ6kvPN7lv3dnUPwsynT+5y16zX5zmTStNzCyNI+MuceLcg4pj++s7ECeNNzNsMf7PwPWFsGrZAEg0hzLjf6IKPHwnjn98fTFgQiZrXxrXRRVjykZkR/3yio4PxBzFzCGHmtfFFZTILy5BLGJlXdDIqEH8QM4cQZl4bzyqzPw0rhlVYSxiZdwWtnApEBxEWwlSrbzOfQVxMjwvMG9YNG4YCbCaEzLeBRh5NCWOZmoJCmKgL4pjPKePrFLdlKBpKhm1D2UdlQvzjt5m7iFYBbQkiFzOEqVZ/wWI+r4yXKHLHUDXUDLuGPQteBLYxu8xZRaOMpgSRt4SwME0XhK3+Eq2mzRcppkqRYwP7hrqhAQczIvPUmdtDq4p20RfCMrVO1QVhq59lv60p8xVWxqPAccFNQ8twaGhDZ0pk/CFzNtGoo1mjBglhjRqzEV0Qu/1tq79O65Up4Bcr1KTYI8OxoQunirOY6DEyzzFzt9FqoF2jli1qs3VBrG3gv/Xp9pe9L6tfogU9CmmxYicU3TOcG/qGC8VlTPSYPnP1mPsErRbaHrWUVBfIWaC3QeQtMU7759Xq79KKTQrqUmQfE1eGa8MAhhMi466Z65K5e2h10K5Ti3RBftptEBWAtH+Rk9hjP7ZZlR4rdkXhN4Zbw2/FXUz0mFvmGjD3BVonaB9Qyw61yTZILADZ/6t8EJH232cFjmjNPgUOKXpsZAT3iocI9N/K+DvmHKLRR/OIGvbVNtigVjkHEg2gwAeSGq3X4nDq0aIDZV7M/oHHCZFxEoqEMECrh3aLWmrUVkgqAH0H0Aeg7P8Gt6cuh9QVrarNi5knxXME+m9lvA7hBq1ztA+pRc4BfRCG3QmmCmATkT1E2xTR57C6pWUflHFt7m9M/IFICCM0rtHsUkODmsrUmGgAmYAA5AA85WAacGiNVMvbjL9EYAtCtsQIjQGap+ogtAWQeesAOpYA7in2yWf+ZUJ0CE/MeW8JoPPeAVQCAhiqAB59AQSZfIWwEPQ2kACGAQFU5hHAGafyUB2AEoBt9V8jsHWBDuAOrUu05xKAFxLAg9r/k5oPCuFZHYRBAXguABfAxw7gdUJcAG4LuABcAB82gNR/EEr1R+HU/zOUun+HU/+FSGq/Ekv9l6Lua3H3w0iKfxpL9Y+jqf15PPUPSLhHZNxDUu4xOfegpHtU1j0s7R6Xdy9MhIWQuldmgkJI1UtTUUGk4rW5uEG4t0jTYtpd/8v1DysYcvhGRB6dAAAAAElFTkSuQmCC';
export type GlbDisplayBounds = { min: Vec; max: Vec; center: Vec; size: Vec; sphereRadius: number };
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const align4 = (n: number) => Math.ceil(n / 4) * 4;
function vector(value: Vec | undefined, fallback: Vec): Vec {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length !== fallback.length || !value.every(Number.isFinite)) throw new Error('Invalid GLB transform/bounds');
  return value;
}
function multiply(a: Vec, b: Vec): Vec {
  return Array.from({ length: 16 }, (_, i) => {
    const row = i % 4, col = Math.floor(i / 4);
    return a[row] * b[col * 4] + a[row + 4] * b[col * 4 + 1] + a[row + 8] * b[col * 4 + 2] + a[row + 12] * b[col * 4 + 3];
  });
}
function transform(node: Node): Vec {
  if (node.matrix) {
    const m = vector(node.matrix, identity());
    if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) throw new Error('Non-affine GLB matrix');
    return m;
  }
  const [x, y, z, w] = vector(node.rotation, [0, 0, 0, 1]);
  if (Math.abs(Math.hypot(x, y, z, w) - 1) > 0.001) throw new Error('Invalid GLB rotation');
  const [sx, sy, sz] = vector(node.scale, [1, 1, 1]);
  const [tx, ty, tz] = vector(node.translation, [0, 0, 0]);
  return [(1 - 2 * (y*y + z*z))*sx, 2*(x*y+z*w)*sx, 2*(x*z-y*w)*sx, 0,
    2*(x*y-z*w)*sy, (1-2*(x*x+z*z))*sy, 2*(y*z+x*w)*sy, 0,
    2*(x*z+y*w)*sz, 2*(y*z-x*w)*sz, (1-2*(x*x+y*y))*sz, 0, tx, ty, tz, 1];
}
function read(bytes: Uint8Array): { doc: Document; bin: Uint8Array } {
  if (bytes.byteLength < 28) throw new Error('Truncated GLB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length) throw new Error('Invalid GLB header');
  let doc: Document | undefined, bin: Uint8Array | undefined;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error('Truncated GLB chunk');
    const size = view.getUint32(offset, true), kind = view.getUint32(offset + 4, true);
    if (size % 4 || offset + 8 + size > bytes.length) throw new Error('Invalid GLB chunk length');
    const data = bytes.subarray(offset + 8, offset + 8 + size);
    if (kind === 0x4e4f534a && offset === 12) doc = JSON.parse(new TextDecoder().decode(data));
    else if (kind === 0x004e4942 && doc && !bin) bin = data;
    else throw new Error('Unsupported GLB chunk');
    offset += 8 + size;
  }
  if (!doc || !bin || doc.asset?.version !== '2.0' || !Array.isArray(doc.buffers) || doc.buffers.length !== 1 || doc.buffers[0].uri !== undefined) throw new Error('Expected self-contained GLB');
  const length = doc.buffers[0].byteLength;
  if (!Number.isInteger(length) || length < 0 || length > bin.length || bin.length - length > 3) throw new Error('Invalid GLB buffer length');
  if (doc.images?.some(image => image.uri !== undefined && !image.uri.startsWith('data:'))) throw new Error('External GLB image');
  for (const entry of doc.bufferViews ?? []) {
    const offset = entry.byteOffset ?? 0;
    if (entry.buffer !== 0 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(entry.byteLength) || entry.byteLength < 0 || offset + entry.byteLength > length) throw new Error('Invalid GLB buffer view');
  }
  return { doc, bin };
}
function modelBounds(doc: Document): GlbDisplayBounds {
  const roots = doc.scenes?.[doc.scene ?? 0]?.nodes;
  if (!roots?.length) throw new Error('GLB has no active scene');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const pending = roots.map(index => ({ index, parent: identity(), ancestors: new Set<number>() }));
  let visits = 0;
  while (pending.length) {
    const { index, parent, ancestors } = pending.pop()!;
    if (++visits > 100000 || ancestors.has(index)) throw new Error('Invalid GLB node hierarchy');
    const node = doc.nodes?.[index];
    if (!node || node.skin !== undefined || node.weights !== undefined) throw new Error('Unsupported GLB node');
    const world = multiply(parent, transform(node));
    if (node.mesh !== undefined) {
      const mesh = doc.meshes?.[node.mesh];
      if (!mesh?.primitives?.length) throw new Error('Invalid GLB mesh');
      for (const primitive of mesh.primitives) {
        if (primitive.targets?.length) throw new Error('Morph geometry bounds unsupported');
        const accessor = doc.accessors?.[primitive.attributes?.POSITION];
        if (!accessor || accessor.type !== 'VEC3' || !accessor.min || !accessor.max) throw new Error('Missing GLB position bounds');
        const lo = vector(accessor.min, [0, 0, 0]), hi = vector(accessor.max, [0, 0, 0]);
        if (lo.some((v, axis) => v > hi[axis])) throw new Error('Invalid GLB position bounds');
        for (let corner = 0; corner < 8; corner++) {
          const p = lo.map((v, axis) => corner & (1 << axis) ? hi[axis] : v);
          for (let axis = 0; axis < 3; axis++) {
            const value = world[axis]*p[0] + world[axis+4]*p[1] + world[axis+8]*p[2] + world[axis+12];
            min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
          }
        }
      }
    }
    const next = new Set(ancestors).add(index);
    for (const child of node.children ?? []) pending.push({ index: child, parent: world, ancestors: next });
  }
  const size = max.map((v, i) => v - min[i]);
  const sphereRadius = Math.hypot(...size) / 2;
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite) || !Number.isFinite(sphereRadius) || sphereRadius <= 0) throw new Error('GLB has no finite geometry bounds');
  return { min, max, size, center: min.map((v, i) => (v + max[i]) / 2), sphereRadius };
}
function room(bounds: GlbDisplayBounds): { positions: number[]; normals: number[] } {
  // A close backdrop sits behind the box. Its back face is culled so rear inspection stays unobstructed.
  const [cx, , cz] = bounds.center, span = bounds.sphereRadius * 12;
  const floor = bounds.min[1] - bounds.sphereRadius * 0.001, top = bounds.max[1] + span;
  const x0 = cx-span, x1 = cx+span, z0 = cz-span, z1 = cz+span;
  const wallZ = bounds.min[2] - Math.max(bounds.size[2] * 0.12, bounds.sphereRadius * 0.04);
  const positions: number[] = [], normals: number[] = [];
  const quad = (a: Vec, b: Vec, c: Vec, d: Vec, normal: Vec) => {
    for (const point of [a, b, c, a, c, d]) { positions.push(...point); normals.push(...normal); }
  };
  quad([x0,floor,z0],[x0,floor,z1],[x1,floor,z1],[x1,floor,z0],[0,1,0]);
  quad([x0,floor,wallZ],[x1,floor,wallZ],[x1,top,wallZ],[x0,top,wallZ],[0,0,1]);
  return { positions, normals };
}
export function composeGlbDisplaySet(bytes: Uint8Array, backgroundLight = 1): { bytes: Uint8Array; bounds: GlbDisplayBounds } {
  const { doc, bin } = read(bytes), bounds = modelBounds(doc);
  const { positions, normals } = room(bounds);
  // The contact plane lies above the display floor and below the original box bottom.
  const [cx, , cz] = bounds.center, y = bounds.min[1] - bounds.sphereRadius * 0.0005;
  const hx = Math.max(bounds.size[0] * 0.8, bounds.sphereRadius * 0.04);
  const hz = Math.max(bounds.size[2] * 0.8, bounds.sphereRadius * 0.04);
  positions.push(cx-hx,y,cz-hz, cx-hx,y,cz+hz, cx+hx,y,cz+hz,
    cx-hx,y,cz-hz, cx+hx,y,cz+hz, cx+hx,y,cz-hz);
  normals.push(...Array.from({ length: 6 }, () => [0,1,0]).flat());
  const uv = [0,0, 0,1, 1,1, 0,0, 1,1, 1,0];
  const geometry = new Float32Array([...positions, ...normals, ...uv]);
  const merged = new Uint8Array(bin.length + geometry.byteLength);
  merged.set(bin); merged.set(new Uint8Array(geometry.buffer), bin.length);
  const views = doc.bufferViews ??= [], accessors = doc.accessors;
  const viewIndex = views.length, accessorIndex = accessors.length;
  views.push({ buffer: 0, byteOffset: bin.length, byteLength: positions.length*4, target: 34962 },
    { buffer: 0, byteOffset: bin.length + positions.length*4, byteLength: normals.length*4, target: 34962 },
    { buffer: 0, byteOffset: bin.length + (positions.length+normals.length)*4, byteLength: uv.length*4, target: 34962 });
  // Table, close backdrop, then the approximate contact plane.
  for (const [start, count] of [[0, 6], [6, 6], [12, 6]]) {
    const points = positions.slice(start * 3, (start + count) * 3);
    const lo = [0,1,2].map(axis => Math.min(...points.filter((_, i) => i%3 === axis)));
    const hi = [0,1,2].map(axis => Math.max(...points.filter((_, i) => i%3 === axis)));
    accessors.push({ bufferView: viewIndex, byteOffset: start*12, componentType: 5126, count, type: 'VEC3', min: lo, max: hi },
      { bufferView: viewIndex+1, byteOffset: start*12, componentType: 5126, count, type: 'VEC3' });
  }
  accessors.push({ bufferView: viewIndex+2, componentType: 5126, count: 6, type: 'VEC2' });
  const materials = doc.materials ??= [], material = materials.length;
  const light = Number.isFinite(backgroundLight) ? Math.min(1.4, Math.max(0.6, backgroundLight)) : 1;
  for (const [name, rgb] of [[DISPLAY_TABLE_MATERIAL, [228,228,232]], [DISPLAY_WALL_MATERIAL, [238,238,236]]] as const) {
    const color = rgb.map(channel => {
      const srgb = Math.min(1, channel / 255 * light);
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    });
    materials.push({ name, pbrMetallicRoughness: { baseColorFactor: [0,0,0,1], metallicFactor: 0, roughnessFactor: 1 },
      emissiveFactor: color, doubleSided: name !== DISPLAY_WALL_MATERIAL,
      extensions: { KHR_materials_specular: { specularFactor: 0 }, KHR_materials_emissive_strength: { emissiveStrength: 1 } } });
  }
  const images = doc.images ??= [], textures = doc.textures ??= [];
  const image = images.length, texture = textures.length;
  images.push({ uri: CONTACT_PNG }); textures.push({ source: image });
  materials.push({ name: DISPLAY_CONTACT_MATERIAL, alphaMode: 'BLEND', doubleSided: true,
    pbrMetallicRoughness: { baseColorFactor: [1,1,1,1], baseColorTexture: { index: texture }, metallicFactor: 0, roughnessFactor: 1 },
    extensions: { KHR_materials_unlit: {} } });
  doc.extensionsUsed = [...new Set([...(doc.extensionsUsed ?? []), 'KHR_materials_specular', 'KHR_materials_emissive_strength', 'KHR_materials_unlit'])];
  const mesh = doc.meshes.length;
  doc.meshes.push({ name: 'Display room only', primitives: [
    { attributes: { POSITION: accessorIndex, NORMAL: accessorIndex+1 }, material },
    { attributes: { POSITION: accessorIndex+2, NORMAL: accessorIndex+3 }, material: material+1 },
    { attributes: { POSITION: accessorIndex+4, NORMAL: accessorIndex+5, TEXCOORD_0: accessorIndex+6 }, material: material+2 },
  ] });
  const node = doc.nodes.length;
  doc.nodes.push({ mesh, name: 'Display room only' });
  doc.scenes[doc.scene ?? 0].nodes!.push(node);
  doc.buffers[0].byteLength = merged.length;
  const json = new TextEncoder().encode(JSON.stringify(doc)), jsonLength = align4(json.length);
  const output = new Uint8Array(12 + 8 + jsonLength + 8 + merged.length), header = new DataView(output.buffer);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, output.length, true);
  header.setUint32(12, jsonLength, true); header.setUint32(16, 0x4e4f534a, true);
  output.fill(32, 20, 20+jsonLength); output.set(json,20);
  header.setUint32(20+jsonLength,merged.length,true); header.setUint32(24+jsonLength,0x004e4942,true);
  output.set(merged,28+jsonLength);
  return { bytes: output, bounds };
}
