import type {BaseChunk} from '../../core/model';
import {chunkOrigin} from '../../core/coordinates';
import type {MapLevel} from '../../session/ports';
import {failed,ok} from '../../world/model';
import type {WorldResult} from '../../world/model';
import type {ContentHasher,WorldCodec} from '../../world/ports';
import type {CaptureRequest,CapturedBase,GeoRegion,RealitySource,SourceTerms} from '../../world/reality';
import {captureBase} from '../../world/reality';
import type {OsmSource} from '../osm/provider';

export type OsmRealityConfig = {maps: OsmSource; hasher: ContentHasher; codec: WorldCodec};

// Real data captured from the OpenStreetMap vector tiles the client already loads. A capture asks the provider for
// exactly the regions it was given — no extra request, no wider area — and records the endpoint, the dataset, the
// normalizer and the zoom the provider really served, so a coarse tile is never presented as the detailed dataset.
// Regions are captured in order, so a caller can line the results up with the region it asked for.
export function createOsmRealitySource(config: OsmRealityConfig): RealitySource {
 const {maps,hasher,codec}=config;
 return {
  async capture(region: GeoRegion, request: CaptureRequest): Promise<WorldResult<CapturedBase[]>> {
   if (!region.chunks.length) return failed('MALFORMED', 'Nenhum trecho foi pedido para captura');
   // A region this client cannot address is a malformed request, not a source that went away: nothing is fetched.
   for (const chunk of region.chunks) {
    try {
     chunkOrigin(chunk);
    } catch {
     return failed('MALFORMED', `Trecho inválido na região pedida: ${chunk}`);
    }
   }
   const metadata=maps.metadata;
   // The provider answers for its own attribution; whoever asked decides only the terms of redistribution, and a source
   // that declares no licence keeps the field absent instead of borrowing one (spec §3.6).
   const terms: SourceTerms={attribution:metadata.attribution.text,url:metadata.attribution.url};
   if (request.terms?.license!==undefined) terms.license=request.terms.license;
   const level: MapLevel=request.level;
   const zoom=level==='overview'?metadata.zooms.overview:metadata.zooms.detail;
   const captured: CapturedBase[]=[];
   for (const chunk of region.chunks) {
    let base: BaseChunk;
    try {
     base=await maps.loadChunk(chunk,level);
    } catch (error) {
     // A source that fails is not terrain: the whole region is refused, including the parts that did arrive, so a
     // partial answer never reads as the region that was asked for.
     return failed('NOT_FOUND',`Fonte indisponível para o trecho ${chunk} (${error instanceof Error?error.message:'falha de rede'}). Nada foi inventado para os trechos pedidos.`);
    }
    captured.push(await captureBase(base,{
     ...request.times,
     codec,
     source: {...metadata.source},
     terms,
     transformation: {...metadata.normalizer},
     capture: {level,zoom},
     ...(request.previous?{previous:request.previous}:{}),
     ...(request.extensions?{extensions:request.extensions}:{}),
    },hasher));
   }
   return ok(captured);
  },
 };
}
