import type {CityFacts} from '../core/municipal-facts';
const names:Record<string,string>={'population':'População estimada','age-share':'Faixa etária','households':'Domicílios','household-size':'Pessoas por domicílio','median-income':'Renda mediana do domicílio','employment-rate':'Taxa de emprego','commute-share':'Deslocamento ao trabalho'};
const categories:Record<string,string>={'household-total':'','car-truck-van':'carro, caminhão ou van','public-transit':'transporte público','walk':'a pé','bicycle':'bicicleta','other':'outros'};
export function demographicLines(facts:CityFacts):string[]{
 const finance=facts.finance;
 const budget=finance?[`Orçamento operacional aprovado: CAD ${finance.operating.value.toLocaleString('pt-BR')} · ${finance.fiscalYear} · ${finance.operating.source.dataset}`,...(finance.capital?[`Despesas anuais de capital aprovadas: CAD ${finance.capital.value.toLocaleString('pt-BR')} · ${finance.fiscalYear}`]:[])]:[];
 return [...budget,...(facts.demographics??[]).filter(o=>!(o.key==='population'&&o.kind==='census')).map(o=>{
  const category=o.category?(categories[o.category]??o.category):'';
  const value=o.value.toLocaleString('pt-BR',{maximumFractionDigits:1});
  const suffix=o.unit==='percent'?'%':o.unit==='CAD'?' CAD':'';
  return `${names[o.key]}${category?` · ${category}`:''}: ${value}${suffix} · ${o.period} · ${o.kind==='census'?'censo':o.kind==='estimate'?'estimativa':'projeção'} · ${o.source.dataset}`;
 })];
}
