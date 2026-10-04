import {expect,it} from 'vitest';
import {lightContext} from '../src/surfaces/canvas/city-light';
it('retains the target identity for consecutive night frames',()=>{const ctx={} as CanvasRenderingContext2D;expect(lightContext(ctx,'night')).toBe(lightContext(ctx,'night'));expect(lightContext(ctx,'day')).toBe(ctx);});
