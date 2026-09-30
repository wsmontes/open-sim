import {encodeSave} from '../../core/snapshot';
import type {SavedGame} from '../../core/model';
import type {SaveStore} from '../../session/ports';
export function createMemoryStore(initial: Record<string,string> = {}): SaveStore & {slots: Map<string,string>} {
 const slots = new Map<string,string>(Object.entries(initial));
 return {
  slots,
  async read(slot: string) {
   const raw = slots.get(slot);
   if (raw === undefined) return null;
   try {return JSON.parse(raw) as unknown;} catch {return raw;}
  },
  async write(slot: string, data: SavedGame) {slots.set(slot, encodeSave(data));},
 };
}
