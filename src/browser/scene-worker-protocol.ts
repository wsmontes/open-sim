import type {WorldView} from '../surfaces/canvas/canvas-renderer';
import type {GameState} from '../core/model';
import type {GeographicScene} from '../presentation/geographic-map';
import type {TerrainTile} from '../presentation/terrain-model';
import type {RenderPolicy} from '../presentation/render-policy';
export type ScenePatch={state?:GameState;geography?:GeographicScene|null;terrain?:{tiles:readonly TerrainTile[];revision:number};seed:number;playerPower?:ReadonlyMap<string,boolean>;chunks?:WorldView['chunks']};
export type SceneWorkerRequest={ticket:number;key:string;scene?:ScenePatch;camera:WorldView['camera'];viewport:WorldView['viewport'];pixelRatio?:number;light?:WorldView['light'];motion:number;mobility?:WorldView['mobility'];signals?:WorldView['signals'];vessels?:WorldView['vessels'];aircraft?:WorldView['aircraft'];policy:RenderPolicy};
export type SceneWorkerResult={ticket:number;key:string;staticReady:boolean;staticOnly?:boolean;bitmap:ImageBitmap;cache:{bytes:number;entries:number};workMs:number};
