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
