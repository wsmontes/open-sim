import {it,expect} from 'vitest';
import {approach,centerOn,cellSpace,rotateTo,zoomTo} from '../src/presentation/camera';
import {toCell} from '../src/core/coordinates';
it('keeps Vancouver centered throughout a combined rotation and zoom glide',()=>{
 const viewport={width:1280,height:720},point=toCell(49.2827,-123.1207),screen={x:640,y:360};
 const from=centerOn(point,{x:0,y:0,zoom:.35,rotation:Math.PI/4},viewport),to=zoomTo(rotateTo(from,viewport,Math.PI/3),viewport,.5);
 for(const fraction of [.1,.25,.5,.75,.9]){const current=approach(from,to,fraction,viewport);const center=cellSpace(screen,current);expect(center.x).toBeCloseTo(point.x,6);expect(center.y).toBeCloseTo(point.y,6);}
});
