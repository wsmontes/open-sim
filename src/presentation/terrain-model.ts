export type GeoBounds={west:number;south:number;east:number;north:number};
export type TerrainTile={id:string;bounds:GeoBounds;size:number;spacingM:number;heightsM:Float32Array;valid:Uint8Array;kind:'dtm'|'dsm';verticalDatum:string;sourceId:string};
export type TerrainManifest={version:1;tiles:readonly {id:string;url:string;bytes:number;bounds:GeoBounds;spacingM:number}[];sources:readonly {id:string;url:string;retrievedAt:string;license:string;kind:'dtm'|'dsm';horizontalCrs:string;verticalDatum:string;resolutionM:number}[]};
