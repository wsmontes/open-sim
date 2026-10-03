import type {CityEconomy, CityStats} from '../core/model';
import type {SaveStatus} from '../session/local-session';

// The words of the top bar, shared by every surface: the canvas shell writes them into its fields and the text surface
// prints them in one line. A number formatted twice is a number that can disagree with itself.
export const grouped = (value: number): string => value.toLocaleString('pt-BR');

export function saveText(status: SaveStatus): string {
 if (status.status === 'saving') return 'Salvando…';
 if (status.status === 'saved') return 'Salvo';
 if (status.status === 'error') return (status.blocked ? 'Save incompatível' : 'Falha ao salvar') + (status.message ? `: ${status.message}` : '');
 return '';
}

type PopulationReading={population?:number;populationYear?:number};
export function realPopulationText(facts:PopulationReading|null|undefined):string {
 const population=facts?.population;
 if(population===undefined||!Number.isSafeInteger(population)||population<0)return '—';
 return `${grouped(population)}${facts?.populationYear?` · ${facts.populationYear}`:''}`;
}

export function statsLine(stats: CityStats,facts?:PopulationReading|null): readonly (readonly [string, string])[] {
 return [
  ['Saldo', grouped(stats.money)],
  ['População real', realPopulationText(facts)],
  ['Felicidade', `${stats.happiness}%`],
  ['Energia', `${stats.energyUsed}/${stats.energySupply}`],
 ];
}

// The exact words of the economy, computed once so the canvas HUD fields and the terminal's "prefeitura" never show
// two different formattings of the same number (the HUD bug this prevents: debt read "1.000" in one place and "1000"
// in another). `net` carries its own sign because a positive balance is good news the player should see as such.
export const netText = (net: number): string => `${net > 0 ? '+' : ''}${grouped(net)}`;

export function economyPanel(economy: CityEconomy): readonly (readonly [string, string])[] {
 return [
  ...(economy.calibration?[["Referência municipal",`${economy.calibration.territoryId} · ${economy.calibration.fiscalYear} · ${economy.calibration.gameUnitsPerCad} unidades/CAD`] as const]:[]),
  ['Imposto', `${economy.taxPercent}%`],
  ['Serviços', `${economy.servicesPercent}%`],
  ['Receita/mês', grouped(economy.monthly.revenue)],
  ['Despesa/mês', grouped(economy.monthly.expense)],
  ['Saldo/mês', netText(economy.monthly.net)],
  ['Dívida', grouped(economy.debt)],
  ['Juros', `${economy.interestRate}% ao ano`],
  ['Classificação', economy.rating],
  // moradia / comércio / indústria: what the city is short of, in the HUD's own order and tooltip.
  ['Demanda (R/C/I)', `${economy.demand.residential} / ${economy.demand.commercial} / ${economy.demand.industrial}`],
  ['Valor da terra', grouped(economy.landValueAverage)],
 ];
}
