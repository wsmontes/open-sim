import {expect,test} from 'vitest';
import {cityColor,lightContext} from '../src/surfaces/canvas/city-light';
test('night lowers terrain brightness while preserving day and transparent effects',()=>{
 expect(cityColor('#b6bd96','day')).toBe('#b6bd96');
 expect(cityColor('#b6bd96','night')).not.toBe('#b6bd96');
 expect(cityColor('rgba(255,220,140,.7)','night')).toBe('rgba(255,220,140,.7)');
});
test('lighting wrapper binds canvas methods and translates only colour properties',()=>{
 const ctx={fillStyle:'',lineWidth:0,fillRect(){expect(this).toBe(ctx);}} as unknown as CanvasRenderingContext2D;
 const lit=lightContext(ctx,'night');lit.fillStyle='#ffffff';lit.lineWidth=3;lit.fillRect(0,0,1,1);
 expect(ctx.fillStyle).toBe(cityColor('#ffffff','night'));expect(ctx.lineWidth).toBe(3);
});
