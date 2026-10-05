// Throwaway read-only probe: node --import tsx docs/quality/2026-10-04-resource-audit/decode-probe.mts
import {decodeVisualTile} from '../../../src/adapters/osm/decode.ts';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {readMobilityAttributes} from '../../../src/adapters/osm/decode.ts';
import {buildNetworkJob} from '../../../src/presentation/mobility-network-job.ts';
import {buildGeographicNetwork} from '../../../src/presentation/mobility-network.ts';
const lat=49.276,lon=-123.124,z=14,n=2**z,x=Math.floor((lon+180)/360*n),y=Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n);
const tiles=[];
function decodeRoads(bytes,z,x,y){const source=new VectorTile(new PbfReader(bytes)),layer=source.layers.streets,features=[];const side=2**22/2**z;if(layer)for(let i=0;i<layer.length;i++){const raw=layer.feature(i);if(raw.type!==2||raw.properties.rail===true)continue;features.push({layer:'streets',kind:String(raw.properties.kind??''),bridge:raw.properties.bridge===true,type:raw.type,name:String(raw.properties.name??''),height:Number(raw.properties.height??0)||undefined,...readMobilityAttributes(raw.properties,z,raw.id),geometry:raw.loadGeometry().map(r=>r.map(p=>({x:x*side+p.x/raw.extent*side,y:y*side+p.y/raw.extent*side})))});}return {z,x,y,features};}
for(const [dx,dy] of [[0,0],[1,0],[0,1],[1,1]]){
 const bytes=new Uint8Array(await (await fetch(`https://vector.openstreetmap.org/shortbread_v1/${z}/${x+dx}/${y+dy}.mvt`)).arrayBuffer());
 const start=performance.now(),tile=decodeVisualTile(bytes,z,x+dx,y+dy),decodeMs=performance.now()-start;
 const count=(features)=>({features:features.length,vertices:features.reduce((n,f)=>n+f.geometry.reduce((m,r)=>m+r.length,0),0)});
 let fullTimes=[],roadTimes=[];let roads;for(let j=0;j<8;j++){let at=performance.now();decodeVisualTile(bytes,z,x+dx,y+dy);fullTimes.push(performance.now()-at);at=performance.now();roads=decodeRoads(bytes,z,x+dx,y+dy);roadTimes.push(performance.now()-at);}const median=(v)=>v.sort((a,b)=>a-b)[Math.floor(v.length/2)];if(JSON.stringify(tile.features.filter(f=>f.layer==='streets'&&f.type===2))!==JSON.stringify(roads.features))throw Error('Road geometry differs');console.log(JSON.stringify({fullMedianMs:median(fullTimes),roadMedianMs:median(roadTimes),tile:`${z}/${x+dx}/${y+dy}`,encodedBytes:bytes.length,decodeMs,all:count(tile.features),streets:count(tile.features.filter(f=>f.layer==='streets'))}));tiles.push(tile);
}

console.log('Probe only: no product code changed.');
