// What the game knows about the real city the player is standing in. Two adapters fill it — Wikidata for the world,
// IBGE for the country it is the statistical authority on — so the shape lives here rather than inside either of them,
// and every field is optional for the same reason: a figure nobody stated is absent, never zero.
import type {CityFacts} from '../../core/municipal-facts';
export type {CityFacts,CityFactsSource,MeasureSource,NumericMeasure,MunicipalFinance} from '../../core/municipal-facts';
export interface CityDirectory {
 named(name: string, language: string): Promise<CityFacts | null>;
 near(lat: number, lon: number, radiusKm: number): Promise<CityFacts | null>;
}
