// What the game knows about the real city the player is standing in. Two adapters fill it — Wikidata for the world,
// IBGE for the country it is the statistical authority on — so the shape lives here rather than inside either of them,
// and every field is optional for the same reason: a figure nobody stated is absent, never zero.
export type CityFactsSource = {dataset: string; url: string; license: string};
export type CityFacts = {
 id: string;
 label: string;
 country?: string;
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
 source: CityFactsSource;
};
export interface CityDirectory {
 named(name: string, language: string): Promise<CityFacts | null>;
 near(lat: number, lon: number, radiusKm: number): Promise<CityFacts | null>;
}
