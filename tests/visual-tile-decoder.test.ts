import {expect,it} from 'vitest';
import {PbfWriter} from 'pbf';
import {decodeVisualTile} from '../src/adapters/osm/decode';
import {createVisualTileDecoder} from '../src/browser/visual-tile-decoder';
const bytes=()=>{
 const pbf=new PbfWriter();
 for(const name of ['streets','buildings'])pbf.writeMessage(3,(_value,p)=>{
  p.writeStringField(1,name);p.writeVarintField(5,4096);p.writeVarintField(15,2);
  p.writeStringField(3,'kind');p.writeStringField(3,'oneway');
  p.writeMessage(4,(_v,v)=>v.writeStringField(1,'residential'),null);
  p.writeMessage(4,(_v,v)=>v.writeBooleanField(7,true),null);
  p.writeMessage(2,(_v,f)=>{f.writeVarintField(1,123);f.writePackedVarint(2,[0,0,1,1]);f.writeVarintField(3,2);f.writePackedVarint(4,[9,0,0,10,20,0]);},null);
 },null);
 return pbf.finish();
};
it('decodes selected layers directly from PBF with the same road geometry and direction',()=>{
 const encoded=bytes(),all=decodeVisualTile(encoded,14,2588,5607),roads=decodeVisualTile(encoded,14,2588,5607,new Set(['streets']));
 expect(all.features).toHaveLength(2);
 expect(roads.features).toEqual(all.features.filter(f=>f.layer==='streets'));
 expect(roads.features[0].oneway).toBe(1);
});
it('retains only mobility geometry and reuses immutable encoded revisions',()=>{
 const encoded=bytes(),tile={z:14,x:2588,y:5607,features:[],encoded,encodedRevision:'one'},decoder=createVisualTileDecoder(1024,new Set(['streets']));
 const first=decoder.decode(tile);
 expect(first.features.map(f=>f.layer)).toEqual(['streets']);
 expect(decoder.decode({...tile,encoded:encoded.slice()})).toBe(first);
 expect(decoder.stats().entries).toBe(1);
 expect(decoder.stats().bytes).toBeLessThan(400);
 decoder.clear();expect(decoder.stats()).toEqual({bytes:0,entries:0});
});
it('budgeted geometry matches normal decoding when no simplification is needed',()=>{
 const encoded=bytes();expect(decodeVisualTile(encoded,14,2588,5607,undefined,{maxPoints:100,tolerance:0}).features).toEqual(decodeVisualTile(encoded,14,2588,5607).features);
});
it('budgeted geometry skips an oversized feature before creating an unbounded point array',()=>{
 const pbf=new PbfWriter(),geometry=[9,0,0,(9999<<3)|2];for(let i=0;i<9999;i++)geometry.push(2,0);
 pbf.writeMessage(3,(_value,p)=>{p.writeStringField(1,'streets');p.writeVarintField(5,4096);p.writeVarintField(15,2);p.writeMessage(2,(_v,f)=>{f.writeVarintField(3,2);f.writePackedVarint(4,geometry);},null);},null);
 const tile=decodeVisualTile(pbf.finish(),14,0,0,undefined,{maxPoints:32,tolerance:0});expect(tile.features).toHaveLength(0);expect(tile.limited).toBe(true);
});
it('regional simplification preserves line endpoints within the point budget',()=>{
 const pbf=new PbfWriter(),geometry=[9,0,0,(99<<3)|2];for(let i=0;i<99;i++)geometry.push(2,0);
 pbf.writeMessage(3,(_value,p)=>{p.writeStringField(1,'streets');p.writeVarintField(5,4096);p.writeVarintField(15,2);p.writeMessage(2,(_v,f)=>{f.writeVarintField(3,2);f.writePackedVarint(4,geometry);},null);},null);
 const tile=decodeVisualTile(pbf.finish(),14,0,0,undefined,{maxPoints:32,tolerance:1}),ring=tile.features[0].geometry[0];expect(ring.length).toBeLessThanOrEqual(32);expect(ring[0]).toEqual({x:0,y:0});expect(ring.at(-1)).toEqual({x:99/16,y:0});
});
it('budgeted polygon rings and holes match normal decoding without simplification',()=>{
 const pbf=new PbfWriter();pbf.writeMessage(3,(_value,p)=>{p.writeStringField(1,'water_polygons');p.writeVarintField(5,4096);p.writeVarintField(15,2);p.writeMessage(2,(_v,f)=>{f.writeVarintField(3,3);f.writePackedVarint(4,[9,0,0,26,200,0,0,200,199,0,15,9,40,159,26,0,120,120,0,0,119,15]);},null);},null);
 const encoded=pbf.finish();expect(decodeVisualTile(encoded,10,1,1,undefined,{maxPoints:100,tolerance:0}).features).toEqual(decodeVisualTile(encoded,10,1,1).features);
});
it('pending multiline endpoints are flushed before the following MoveTo',()=>{
 const pbf=new PbfWriter();pbf.writeMessage(3,(_value,p)=>{p.writeStringField(1,'streets');p.writeVarintField(5,4096);p.writeVarintField(15,2);p.writeMessage(2,(_v,f)=>{f.writeVarintField(3,2);f.writePackedVarint(4,[9,0,0,10,2,0,9,38,0,10,2,0]);},null);},null);
 const tile=decodeVisualTile(pbf.finish(),14,0,0,undefined,{maxPoints:100,tolerance:10});expect(tile.features[0].geometry).toEqual([[{x:0,y:0},{x:1/16,y:0}],[{x:20/16,y:0},{x:21/16,y:0}]]);
});
