import type { CellCoord } from './model';
export const WORLD = 2 ** 22;
export const CHUNK = 32;
export const wrapX = (x: number) => ((x % WORLD) + WORLD) % WORLD;
export function toCell(lat: number, lon: number): CellCoord {
 if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Coordenadas inválidas');
 const phi=Math.max(-85.05112878,Math.min(85.05112878,lat))*Math.PI/180;
 return {x:wrapX(Math.floor((lon+180)/360*WORLD)),y:Math.max(0,Math.min(WORLD-1,Math.floor((1-Math.asinh(Math.tan(phi))/Math.PI)/2*WORLD)))};
}
export function toGeo({x,y}:CellCoord){return {lon:wrapX(x)/WORLD*360-180,lat:Math.atan(Math.sinh(Math.PI*(1-2*y/WORLD)))*180/Math.PI};}
export function validCell(p:CellCoord){return Number.isInteger(p.x)&&p.x>=0&&p.x<WORLD&&Number.isInteger(p.y)&&p.y>=0&&p.y<WORLD;}
export const chunkId = (p:CellCoord) => `${Math.floor(wrapX(p.x)/CHUNK)}:${Math.floor(p.y/CHUNK)}`;
export const cellIndex = (p:CellCoord) => (p.y%CHUNK)*CHUNK+(wrapX(p.x)%CHUNK);
export function chunkOrigin(id:string):CellCoord {const [x,y]=id.split(':').map(Number);if(!/^\d+:\d+$/.test(id)||!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=WORLD/CHUNK||y>=WORLD/CHUNK)throw new Error('Trecho inválido');return{x:x*CHUNK,y:y*CHUNK};}
export function coordAt(id:string,i:number):CellCoord {const p=chunkOrigin(id);return{x:p.x+i%CHUNK,y:p.y+Math.floor(i/CHUNK)};}
export function variant(x:number,y:number,seed=0){return (Math.imul(x,73856093)^Math.imul(y,19349663)^seed)>>>0;}
