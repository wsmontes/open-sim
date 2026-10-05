import {expect,it} from 'vitest';
import {createCameraUpdateGate} from '../src/presentation/camera-update-gate';
it('compares camera values, not object identity, and resets on all selection inputs',()=>{const g=createCameraUpdateGate(),c={x:1,y:2,zoom:.3,rotation:0},v={width:100,height:100};expect(g.changed(c,v)).toBe(true);expect(g.changed({...c},{...v})).toBe(false);for(const changed of [{...c,x:2},{...c,zoom:.4},{...c,rotation:1}])expect(g.changed(changed,v)).toBe(true);expect(g.changed(c,{...v,width:200})).toBe(true);g.reset();expect(g.changed(c,v)).toBe(true);});
