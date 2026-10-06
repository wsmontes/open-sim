// Coordinated estimates of managed allocations. This is not free RAM or whole-process memory.
export function resourcePolicy(memoryGb?:number){
 const low=memoryGb!==undefined&&memoryGb<=2,medium=memoryGb!==undefined&&memoryGb<=4;
 const rasterBytes=(low?32:medium?64:128)*1024*1024,totalBytes=rasterBytes*3;
 const partitions={rasterBytes,sceneGeometryBytes:rasterBytes/4,providerEncodedBytes:rasterBytes/16,geographicEncodedBytes:rasterBytes/8,terrainSourceBytes:rasterBytes/16,terrainSceneBytes:rasterBytes/16,terrainWorkerBytes:rasterBytes/16,mobilityEncodedBytes:rasterBytes/16,mobilityGeometryBytes:rasterBytes/16,mobilityInputBytes:rasterBytes/8,mobilityNetworkBytes:rasterBytes/4,mobilityNetworkCopyBytes:rasterBytes/4,normalizationBytes:rasterBytes/8,networkTransientBytes:rasterBytes/4};
 const headroomBytes=totalBytes-Object.values(partitions).reduce((a,b)=>a+b,0),networkConcurrency=low?2:4;
 return {totalBytes,...partitions,headroomBytes,networkConcurrency,maxTileBytes:Math.floor((partitions.networkTransientBytes-65536)/(2*networkConcurrency)),mobilityMaxEdges:Math.floor(partitions.mobilityNetworkBytes/(2*1024))};
}
export type ResourcePolicy=ReturnType<typeof resourcePolicy>;
