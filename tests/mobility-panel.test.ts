// @vitest-environment jsdom
import {it,expect,vi} from 'vitest';
import {createMobilityPanel} from '../src/surfaces/canvas/mobility-panel';
it('movement_toggle_and_explicit_scenario_are_independent_of_game_speed',()=>{const root=document.createElement('div'),onMovement=vi.fn(),onScenario=vi.fn();createMobilityPanel(root,{onMovement,onScenario});const toggle=root.querySelector<HTMLInputElement>('input[type=checkbox]')!;toggle.checked=false;toggle.dispatchEvent(new Event('change'));expect(onMovement).toHaveBeenCalledWith(false);const input=root.querySelector<HTMLInputElement>('input[type=datetime-local]')!;input.value='2026-10-05T08:00';root.querySelector<HTMLButtonElement>('[data-scenario-apply]')!.click();expect(onScenario).toHaveBeenCalledWith('2026-10-05T15:00:00.000Z');root.querySelector<HTMLButtonElement>('[data-scenario-now]')!.click();expect(onScenario).toHaveBeenLastCalledWith(null);});
it('unavailable_calibrated_mode_and_schedule_coverage_are_visible',()=>{const root=document.createElement('div');createMobilityPanel(root,{onMovement:()=>{},onScenario:()=>{}});expect(root.textContent).toContain('Contagens de trânsito indisponíveis');expect(root.textContent).toContain('3–5/10/2026');expect(root.querySelector('option[value=calibrated]')!.hasAttribute('disabled')).toBe(true);expect(root.querySelectorAll('a').length).toBeGreaterThan(2);});
// The panel describes one city's traffic. Where that city's coverage does not reach, the clock and the route list must
// not keep claiming it: the player would be reading Vancouver's schedule while looking at another continent.
it('city_specific_controls_disappear_outside_their_coverage',()=>{
 const root=document.createElement('div'),panel=createMobilityPanel(root,{onMovement:()=>{},onScenario:()=>{}});
 const city=root.querySelector<HTMLElement>('[data-city-controls]')!,outside=root.querySelector<HTMLElement>('[data-outside]')!;
 panel.setCoverage(true);
 expect(city.hidden).toBe(false);expect(outside.hidden).toBe(true);
 panel.setCoverage(false);
 expect(city.hidden).toBe(true);expect(outside.hidden).toBe(false);
 expect(outside.textContent).toContain('Sem dados');
 // The movement switch belongs to the city the player is looking at, not to Vancouver: it stays usable everywhere.
 expect(root.querySelector<HTMLInputElement>('input[type=checkbox]')!.hidden).toBe(false);
});
