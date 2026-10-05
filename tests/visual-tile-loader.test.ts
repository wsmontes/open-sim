import {expect,it,vi} from 'vitest';
import {loadBrowserTile} from '../src/browser/visual-tile-loader';
it('browser streams use encoded bytes even if worker/canvas capabilities are absent',async()=>{
 vi.stubGlobal('Worker',undefined);vi.stubGlobal('OffscreenCanvas',undefined);
 try{const tile={z:14,x:1,y:2,features:[],encoded:new Uint8Array(2)},source={loadEncodedTile:vi.fn(async()=>tile),loadVisualTile:vi.fn(async()=>{throw new Error('UI decode forbidden');})};expect(await loadBrowserTile(source,14,1,2)).toBe(tile);expect(source.loadVisualTile).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
});
