// Stable identity for joining statistical sources; names alone never establish jurisdiction.
export type CityIdentity={
 qid:string;
 name:string;
 countryCode:string;
 provinceCode?:string;
 officialCode?:string;
 dguid?:string;
 geography:'municipality'|'metro'|'province';
 boundaryVersion?:string;
};

export type MeasureSource={dataset:string;url:string;license?:string;territoryId:string;retrievedAt:string;observedYear?:number;method:'reported'|'derived'|'simulated';reference?:string};
export type NumericMeasure={value:number;unit:'people'|'km2'|'CAD';source:MeasureSource};
export type MunicipalFinance={territoryId:string;fiscalYear:number;operating:NumericMeasure;capital?:NumericMeasure;status:'approved-budget'};
export type DemographicObservation={key:'population'|'age-share'|'households'|'household-size'|'median-income'|'employment-rate'|'commute-share';category?:string;value:number;unit:'people'|'households'|'persons-per-household'|'CAD'|'percent';period:string;geographyId:string;kind:'census'|'estimate'|'projection';quality:readonly string[];source:MeasureSource};
export type CityFactsSource = {dataset: string; url: string; license: string};
export type CityFacts = {
 id: string;
 label: string;
 country?: string;
 countryCode?: string;
 identity?: CityIdentity;
 population?: number;
 populationYear?: number;
 areaKm2?: number;
 // The national statistics code of the municipality, when the source carries one: it is how a second source is joined
 // without trusting that two cities sharing a name are the same city.
 municipalCode?: string;
 // Figures a census office publishes and a general encyclopedia does not: how tightly people live, and what the place
 // produces. The game's own books lean on both to feel like the city the player knows.
 densityPerKm2?: number;
 gdpThousandsBrl?: number;
 gdpYear?: number;
 measures?: {population?: NumericMeasure;areaKm2?: NumericMeasure};
 finance?: MunicipalFinance;
 demographics?: readonly DemographicObservation[];
 source: CityFactsSource;
};
