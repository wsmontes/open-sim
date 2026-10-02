// @vitest-environment jsdom
import {expect,test} from 'vitest';
import {MAX_ZOOM,MIN_ZOOM,nextZoomStep,pick,snapZoom,zoomLadder} from '../src/presentation/camera';
import type {Camera} from '../src/presentation/camera';
import {attachInput} from '../src/surfaces/canvas/input';

// The three gestures a wheel event can be, as a player meets them on a laptop: a mouse notch, a touchpad pinch and a
// two-finger touchpad swipe. Reported from the published game: two fingers on a touchpad scrambled the view, and the
// zoom only went one step in and out and stayed far away with no detail.
const SCALE = 0.5;
function mount(start: Camera) {
 const canvas = document.createElement('canvas');
 canvas.width = 320; canvas.height = 200; document.body.append(canvas);
 let camera = start;
 const moves: {camera: Camera; snap: boolean}[] = [];
 const detach = attachInput(canvas, {camera: () => camera, tool: () => 'explore' as const, zoomScale: () => SCALE}, {
  onHover: () => {}, onPreview: () => {}, onCommit: () => {}, onTool: () => {}, onTap: () => {}, onCancel: () => {},
  onCamera: (next, options) => { camera = next; moves.push({camera: next, snap: options?.snap === true}); },
 });
 const wheel = (init: WheelEventInit) => canvas.dispatchEvent(new WheelEvent('wheel', {clientX: 160, clientY: 100, bubbles: true, cancelable: true, ...init}));
 return {wheel, camera: () => camera, moves, detach};
}

test('the old rule could not leave the whole-city view: a factor rounded to the nearest step lands where it started', () => {
 expect(snapZoom(MIN_ZOOM * 1.25, SCALE)).toBe(MIN_ZOOM);
 // The steps are measured in pixels per tile, so far out they are much wider apart than any fixed factor.
 const ladder = zoomLadder(SCALE);
 expect(ladder[1]! / ladder[0]!).toBeGreaterThan(1.25);
});

test('a zoom step always moves to the neighbouring crisp step, from the farthest view to the nearest and back', () => {
 let zoom = MIN_ZOOM, steps = 0;
 while (zoom < MAX_ZOOM) { const next = nextZoomStep(zoom, SCALE, 1); expect(next).toBeGreaterThan(zoom); zoom = next; steps += 1; }
 expect(steps).toBe(zoomLadder(SCALE).length - 1);
 expect(nextZoomStep(MAX_ZOOM, SCALE, 1)).toBe(MAX_ZOOM);
 while (zoom > MIN_ZOOM) { const next = nextZoomStep(zoom, SCALE, -1); expect(next).toBeLessThan(zoom); zoom = next; }
 expect(nextZoomStep(MIN_ZOOM, SCALE, -1)).toBe(MIN_ZOOM);
});

test('mouse wheel notches walk from the whole city to street level, one crisp step each, anchored on the pointer', () => {
 const view = mount({x: 160, y: 100, zoom: .05, rotation: 0});
 const under = pick({x: 160, y: 100}, view.camera());
 for (let i = 0; i < 10; i++) view.wheel({deltaY: -100});
 expect(view.camera().zoom).toBeGreaterThanOrEqual(1);
 expect(view.moves.every(move => move.snap && zoomLadder(SCALE).includes(move.camera.zoom))).toBe(true);
 expect(pick({x: 160, y: 100}, view.camera())).toEqual(under);
 // A line-mode wheel (Firefox) is a notch too.
 const zoomed = view.camera().zoom;
 view.wheel({deltaY: 3, deltaMode: 1});
 expect(view.camera().zoom).toBeLessThan(zoomed);
 view.detach();
});

test('a two-finger touchpad swipe moves the map and never zooms it', () => {
 const view = mount({x: 160, y: 100, zoom: 1, rotation: 0.6});
 for (const [deltaX, deltaY] of [[4, -3], [12.5, 7], [-6, 22], [0, 18], [30, 0]]) view.wheel({deltaX, deltaY});
 expect(view.camera().zoom).toBe(1);
 expect(view.camera().rotation).toBeCloseTo(0.6, 9);
 expect(view.camera().x).toBeCloseTo(160 - (4 + 12.5 - 6 + 0 + 30), 6);
 expect(view.camera().y).toBeCloseTo(100 - (-3 + 7 + 22 + 18 + 0), 6);
 view.detach();
});

test('a touchpad pinch zooms continuously about the fingers, without snapping mid-gesture', () => {
 const view = mount({x: 160, y: 100, zoom: 1, rotation: 0});
 const under = pick({x: 160, y: 100}, view.camera());
 for (let i = 0; i < 10; i++) view.wheel({deltaY: -4, ctrlKey: true});
 const zoom = view.camera().zoom;
 expect(zoom).toBeGreaterThan(1.3);
 expect(view.moves.every(move => !move.snap)).toBe(true);
 expect(pick({x: 160, y: 100}, view.camera())).toEqual(under);
 for (let i = 0; i < 10; i++) view.wheel({deltaY: 4, ctrlKey: true});
 expect(view.camera().zoom).toBeCloseTo(1, 9);
 view.detach();
});
