import {expect,test} from 'vitest';
import {MIN_ZOOM,zoomLadder} from '../src/presentation/camera';
test('zoom reaches the planet with intermediate scales rather than one giant jump',()=>{
 expect(MIN_ZOOM).toBeLessThan(.000005);
 const steps=zoomLadder(1);
 expect(steps.some(z=>z>.0001&&z<.001)).toBe(true);
 for(let i=1;i<steps.length;i++)expect(steps[i]/steps[i-1]).toBeLessThanOrEqual(2.1);
});
