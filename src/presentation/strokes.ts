import type {CellCoord} from '../core/model';
// The geometry of a gesture: which cells a line or a box drawn from one cell to another covers. It knows nothing about
// pointers, keys or screens, so a canvas drag, a typed command and a recorded playthrough lay down the same cells.
export type StrokeShape='line'|'box';
export type StrokeState = {anchor:CellCoord;cells:CellCoord[];last:CellCoord};
// One command carries at most this many cells (src/core/quote.ts refuses more), so a gesture can never build a
// selection the world will not accept.
export const MAX_STROKE=1024;
export function strokeCells(from:CellCoord,to:CellCoord):CellCoord[] {
 let x=from.x,y=from.y;
 const dx=Math.abs(to.x-x),dy=-Math.abs(to.y-y),sx=x<to.x?1:-1,sy=y<to.y?1:-1;
 let err=dx+dy;
 const cells=[{x,y}];
 while((x!==to.x||y!==to.y)&&cells.length<MAX_STROKE){
  const e2=2*err;
  if(e2>=dy){err+=dy;x+=sx;}
  if(e2<=dx){err+=dx;y+=sy;}
  cells.push({x,y});
 }
 return cells;
}
// The rectangle between the anchor and the far corner, clamped to what one command can carry. The clamp pulls the far
// corner in instead of cutting cells off the edge: what the player sees is still a rectangle, just a smaller one.
export function boxCells(anchor:CellCoord,corner:CellCoord,limit=MAX_STROKE):CellCoord[] {
 let width=Math.abs(corner.x-anchor.x)+1,height=Math.abs(corner.y-anchor.y)+1;
 if(width*height>limit){
  const room=Math.max(1,Math.floor(limit/Math.max(1,Math.min(width,height))));
  if(width>=height)width=Math.min(width,Math.max(1,room));else height=Math.min(height,Math.max(1,room));
  // A square limit can still round up by one cell; trim the larger side until it fits.
  while(width*height>limit){if(width>=height)width-=1;else height-=1;}
 }
 const stepX=corner.x>=anchor.x?1:-1,stepY=corner.y>=anchor.y?1:-1,cells:CellCoord[]=[];
 for(let row=0;row<height;row++)for(let column=0;column<width;column++)cells.push({x:anchor.x+column*stepX,y:anchor.y+row*stepY});
 return cells;
}
export const beginStroke=(cell:CellCoord,_shape:StrokeShape='line'):StrokeState=>({anchor:{x:cell.x,y:cell.y},cells:[{x:cell.x,y:cell.y}],last:{x:cell.x,y:cell.y}});
// Appends the freshly crossed cells of the segment, never revisiting a cell already in the stroke. A box is redrawn
// from its anchor every time instead: a drag that comes back leaves one cell, not a trail of everything it touched.
export function extendStroke(stroke:StrokeState,cell:CellCoord,shape:StrokeShape='line'):StrokeState {
 if(shape==='box'){
  if(cell.x===stroke.last.x&&cell.y===stroke.last.y)return stroke;
  return {...stroke,cells:boxCells(stroke.anchor,cell),last:{x:cell.x,y:cell.y}};
 }
 if(cell.x===stroke.last.x&&cell.y===stroke.last.y)return stroke;
 const cells=stroke.cells.slice();
 const seen=new Set(cells.map(p=>`${p.x}:${p.y}`));
 for(const p of strokeCells(stroke.last,cell)){
  if(cells.length>=MAX_STROKE)break;
  const key=`${p.x}:${p.y}`;if(!seen.has(key)){seen.add(key);cells.push(p);}
 }
 return {cells,last:{x:cell.x,y:cell.y},anchor:stroke.anchor};
}
