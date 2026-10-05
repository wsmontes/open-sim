// @vitest-environment jsdom
import {expect,test} from 'vitest';
import {attachOfflineRegion} from '../src/browser/offline-controller';
import type {OsmSource} from '../src/adapters/osm/provider';
import type {RegionCoverage} from '../src/adapters/osm/region-cache';
const root=()=>{const node=document.createElement('div');node.innerHTML='<button id="offline-prepare">Guardar</button><button id="offline-stop" hidden>Parar</button><span id="offline-status"></span>';return node;};
test('a budget stop asks for a smaller region instead of a resume',async()=>{
 const node=root();attachOfflineRegion(node,{prepareRegion:async()=>({required:2,stored:0,bytes:0,failures:0,complete:false,stopped:true,stopReason:'budget'})} as unknown as OsmSource,()=>({x:0,y:0}));
 node.querySelector<HTMLButtonElement>('#offline-prepare')!.click();await Promise.resolve();
 expect(node.textContent).toContain('escolha uma região menor');expect(node.querySelector('#offline-prepare')!.textContent).toBe('Guardar outra região');
});
test('detaching the controller prevents late results changing its DOM',async()=>{
 const node=root();let finish!:(coverage:RegionCoverage)=>void;
 const detach=attachOfflineRegion(node,{prepareRegion:()=>new Promise(resolve=>{finish=resolve;})} as unknown as OsmSource,()=>({x:0,y:0}));
 node.querySelector<HTMLButtonElement>('#offline-prepare')!.click();detach();const before=node.innerHTML;
 finish({required:1,stored:1,bytes:1,failures:0,complete:true,stopped:false});await Promise.resolve();
 expect(node.innerHTML).toBe(before);
});
