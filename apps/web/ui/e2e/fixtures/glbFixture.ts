export function carton(white = false): Buffer {
  const positions: number[] = [], normals: number[] = [], uv: number[] = [], indices: number[] = [];
  const faces = [
    [[0,0,1],[-.04,-.12,.025],[.04,-.12,.025],[.04,.12,.025],[-.04,.12,.025]],
    [[0,0,-1],[.04,-.12,-.025],[-.04,-.12,-.025],[-.04,.12,-.025],[.04,.12,-.025]],
    [[1,0,0],[.04,-.12,.025],[.04,-.12,-.025],[.04,.12,-.025],[.04,.12,.025]],
    [[-1,0,0],[-.04,-.12,-.025],[-.04,-.12,.025],[-.04,.12,.025],[-.04,.12,-.025]],
    [[0,1,0],[-.04,.12,.025],[.04,.12,.025],[.04,.12,-.025],[-.04,.12,-.025]],
    [[0,-1,0],[-.04,-.12,-.025],[.04,-.12,-.025],[.04,-.12,.025],[-.04,-.12,.025]],
  ];
  for (const [normal,...vertices] of faces) {
    const start = positions.length / 3;
    vertices.forEach(v => { positions.push(...v); normals.push(...normal); });
    uv.push(0,0,1,0,1,1,0,1); indices.push(start,start+1,start+2,start,start+2,start+3);
  }
  const chunks = [Buffer.from(new Float32Array(positions).buffer), Buffer.from(new Float32Array(normals).buffer),
    Buffer.from(new Float32Array(uv).buffer), Buffer.from(new Uint16Array(indices).buffer)];
  let offset = 0;
  const views = chunks.map((bytes,i) => { const view = {buffer:0,byteOffset:offset,byteLength:bytes.length,target:i===3?34963:34962}; offset += bytes.length; return view; });
  const binary = Buffer.concat(chunks);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4//+/QcAEBiAGsgA4BAgb2aZ04QAAAABJRU5ErkJggg==';
  const raw = Buffer.from(JSON.stringify({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'front',mesh:0,translation:[0,.12,0]}],
    meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,TEXCOORD_0:2},indices:3,material:0}]}],
    materials:[{pbrMetallicRoughness:{...(white ? {} : {baseColorTexture:{index:0}}),baseColorFactor:white?[.7,.7,.7,1]:[.5,.3,.2,1],metallicFactor:0,roughnessFactor:.7}}],
    textures:[{source:0}],images:[{uri:png}],buffers:[{byteLength:binary.length}],bufferViews:views,
    accessors:[{bufferView:0,componentType:5126,count:24,type:'VEC3',min:[-.04,-.12,-.025],max:[.04,.12,.025]},
      {bufferView:1,componentType:5126,count:24,type:'VEC3'},{bufferView:2,componentType:5126,count:24,type:'VEC2'},
      {bufferView:3,componentType:5123,count:36,type:'SCALAR'}]}));
  const json = Buffer.concat([raw,Buffer.alloc((4-raw.length%4)%4,32)]), header=Buffer.alloc(20), binHeader=Buffer.alloc(8);
  header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+binary.length,8);
  header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
  binHeader.writeUInt32LE(binary.length);binHeader.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,json,binHeader,binary]);
}
