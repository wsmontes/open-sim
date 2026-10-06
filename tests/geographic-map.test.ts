import {expect,test} from 'vitest';
import {WORLD,toCell} from '../src/core/coordinates';
import {MIN_ZOOM,zoomLadder,centerOn,visibleChunks,cellSpace} from '../src/presentation/camera';
import {geographicTiles,geographicSelection,globePoint,globeCoord} from '../src/presentation/geographic-map';
import {decodeVisualTile} from '../src/adapters/osm/decode';

test('zoom can encompass Earth and still has reachable intermediate steps',()=>{
 expect(MIN_ZOOM).toBeLessThan(.000005);
 const steps=zoomLadder(1);
 expect(steps[0]).toBe(MIN_ZOOM);
 expect(steps.some(z=>z>.0001&&z<.001)).toBe(true);
 for(let i=1;i<steps.length;i++)expect(steps[i]/steps[i-1]).toBeLessThanOrEqual(2.1);
});
test('world zoom never enumerates millions of simulation regions',()=>{
 const camera=centerOn(toCell(49.2827,-123.1207),{x:0,y:0,zoom:MIN_ZOOM,rotation:0},{width:1000,height:700});
 expect(visibleChunks(camera,{width:1000,height:700})).toEqual([]);
});
test('tile demand stays bounded at every geographic scale and wraps longitude',()=>{
 for(const zoom of [1,.05,.005,.0005,.00005]){
  const camera=centerOn({x:WORLD-2,y:WORLD/2},{x:0,y:0,zoom,rotation:.8},{width:1000,height:700});
  const tiles=geographicTiles(camera,{width:1000,height:700});
  expect(tiles.length).toBeGreaterThan(0);
  expect(tiles.length).toBeLessThanOrEqual(40);
  for(const tile of tiles){expect(tile.x).toBeGreaterThanOrEqual(0);expect(tile.x).toBeLessThan(2**tile.z);expect(tile.y).toBeGreaterThanOrEqual(0);expect(tile.y).toBeLessThan(2**tile.z);}
 }
});
test('globe projection shows the selected geography in the centre, hides the far hemisphere and reverses picking',()=>{
 const focus={lat:49.2827,lon:-123.1207};
 const point=globePoint(focus,focus,200);
 expect(point.x).toBeCloseTo(0);expect(point.y).toBeCloseTo(0);expect(point.visible).toBe(true);
 expect(globePoint({lat:-49.2827,lon:56.8793},focus,200).visible).toBe(false);
 const place={lat:38.7223,lon:-9.1393},from={lat:35,lon:-20};
 const p=globePoint(place,from,200),picked=globeCoord(p,from,200)!;
 expect(picked.lat).toBeCloseTo(place.lat);expect(picked.lon).toBeCloseTo(place.lon);
 expect(globeCoord({x:210,y:0},from,200)).toBeNull();
});
test('an empty vector tile decodes to a visual tile without normalizing global cells',()=>{
 expect(decodeVisualTile(new Uint8Array(),0,0,0)).toEqual({z:0,x:0,y:0,features:[]});
});

test('dragging the globe horizontally changes longitude without coupling it to latitude',async()=>{
 const {dragGlobe}=await import('../src/presentation/geographic-map');
 const viewport={width:800,height:600},focus=toCell(49.2827,-123.1207);
 const camera=centerOn(focus,{x:0,y:0,zoom:.000003,rotation:0},viewport);
 const next=dragGlobe(camera,viewport,{x:400,y:300},{x:450,y:300});
 const {geographicFocus}=await import('../src/presentation/geographic-map');
 const before=geographicFocus(camera,viewport),after=geographicFocus(next,viewport);
 expect(after.lon).toBeLessThan(before.lon);expect(after.lat).toBeCloseTo(before.lat,2);
});

test('a retina viewport keeps every visible corner in the bounded tile demand',()=>{
 const viewport={width:3840,height:2160},camera=centerOn(toCell(49.2827,-123.1207),{x:0,y:0,zoom:.025,rotation:Math.PI/4},viewport);
 const tiles=geographicTiles(camera,viewport),side=WORLD/2**tiles[0].z;
 for(const point of [{x:0,y:0},{x:3840,y:0},{x:0,y:2160},{x:3840,y:2160}]){
  const p=cellSpace(point,camera),x=((Math.floor(p.x/side)%2**tiles[0].z)+2**tiles[0].z)%2**tiles[0].z,y=Math.floor(p.y/side);
  expect(tiles.some(t=>t.x===x&&t.y===y)).toBe(true);
 }
 expect(tiles.length).toBeLessThanOrEqual(40);
});

test.each([4,10,20,40])('pressure keeps complete disjoint coverage within %s tiles',maxTiles=>{
 const viewport={width:1772,height:1568},camera=centerOn(toCell(49.283,-123.121),{x:0,y:0,zoom:.06,rotation:Math.PI/4},viewport);
 const selection=geographicSelection(camera,viewport,{zoomBias:4,minimumZoom:14,maxTiles});expect(selection.tiles.length).toBeLessThanOrEqual(maxTiles);
 for(let y=0;y<=viewport.height;y+=196)for(let x=0;x<=viewport.width;x+=221){const p=cellSpace({x,y},camera);expect(selection.tiles.filter(t=>{const side=WORLD/2**t.z;return p.x>=t.worldX*side&&p.x<(t.worldX+1)*side&&p.y>=t.y*side&&p.y<(t.y+1)*side;}).length).toBe(1);}
 expect(selection.limited).toBe(selection.tiles.some(t=>t.z<14));
});
