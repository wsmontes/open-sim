import type {GeographicTile} from '../presentation/geographic-map';
type VisualSource={loadEncodedTile?:(z:number,x:number,y:number)=>Promise<GeographicTile>;loadVisualTile:(z:number,x:number,y:number)=>Promise<GeographicTile>};
// Loading capability and rendering capability are independent. A failed worker must not route OSM decoding
// back onto the UI thread. Sources without encoded support retain their existing fixture/adapter contract.
export function loadBrowserTile(source:VisualSource,z:number,x:number,y:number){return source.loadEncodedTile?source.loadEncodedTile(z,x,y):source.loadVisualTile(z,x,y);}
