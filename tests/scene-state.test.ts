import {it,expect} from 'vitest';
import {compactSceneState} from '../src/browser/scene-state';
import {createGame} from '../src/core/commands';
import {blank} from './fixtures/world';
import type {WorldView} from '../src/surfaces/canvas/canvas-renderer';
it('omits imported simulation cells while preserving player edits, neighbours and power readings',()=>{const state=createGame('fixture',1,blank('0:0')),base=state.chunks['0:0'];base.base.cells[1]={terrain:'land',road:true};base.edits['0']={terrain:'land',road:true};base.edits['2']={terrain:'land',building:'residential',origin:'imported',stage:4};const view={state,chunks:new Map()} as unknown as WorldView;const result=compactSceneState(view);expect(result.state.chunks['0:0'].edits).toEqual({'0':base.edits['0']});expect(result.state.chunks['0:0'].base.cells[1]).toEqual(base.base.cells[1]);expect(result.state.chunks['0:0'].base.cells.filter(Boolean).length).toBeLessThan(10);expect(compactSceneState(view)).toBe(result);});
