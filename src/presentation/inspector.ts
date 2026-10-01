import type {CellCoord} from '../core/model';
import type {CellReading} from '../core/simulation';

// What the player touched. It sits beside the touch — or, where there is no room for a card, along the bottom edge —
// and it says what is there and where the game knows it from. It is not a screen: it has no close button, because
// letting go of the city is what closes it.
export type InspectorInfo = {cell:CellCoord;reading:CellReading;at:{x:number;y:number}};
export type Inspector = {show(info:InspectorInfo|null):void; destroy():void};

const KIND:Record<string,string>={residential:'Moradia',commercial:'Comércio',industrial:'Indústria',park:'Parque',power:'Usina'};
const ROAD:Record<string,string>={street:'rua',avenue:'avenida',highway:'estrada'};
const TERRAIN:Record<string,string>={water:'Água',green:'Vegetação',land:'Terreno'};

function titleOf(reading:CellReading):string {
 if(reading.building&&KIND[reading.building]){
  const floors=reading.stage?` · ${reading.stage} ${reading.stage===1?'andar':'andares'}`:'';
  const pending=reading.stage===0?' · lote vazio':'';
  return `${KIND[reading.building]}${reading.stage===0?pending:floors}`;
 }
 if(reading.road)return `Rua · ${ROAD[reading.road]??reading.road}`;
 return TERRAIN[reading.terrain]??'Terreno';
}

export function createInspector(root:HTMLElement):Inspector {
 const card=root.querySelector<HTMLElement>('#hud-inspector');
 const view=root.ownerDocument.defaultView;
 return {
  show(info){
   if(!card)return;
   if(!info){
    card.hidden=true;
    card.replaceChildren();
    return;
   }
   const {reading,at}=info;
   const heading=root.ownerDocument.createElement('h3');
   heading.textContent=titleOf(reading);
   const rows=root.ownerDocument.createElement('dl');
   const row=(label:string,value:string)=>{
    const wrap=root.ownerDocument.createElement('div');
    const dt=root.ownerDocument.createElement('dt'),dd=root.ownerDocument.createElement('dd');
    dt.textContent=label;dd.textContent=value;
    wrap.append(dt,dd);
    rows.append(wrap);
   };
   // Only what is true of this cell: a house has no jobs and a shop has no residents, and a row saying "0 moradores"
   // in a factory is a row about nothing.
   if(reading.residents)row('Moradores',reading.residents.toLocaleString('pt-BR'));
   if(reading.jobs)row('Empregos',reading.jobs.toLocaleString('pt-BR'));
   row('Valor da terra',reading.landValue.toLocaleString('pt-BR'));
   row('Quadra',`${info.cell.x}, ${info.cell.y}`);
   const source=root.ownerDocument.createElement('p');
   source.className='inspector-source';
   source.textContent=reading.origin==='imported'
    ? 'Terreno e construção vieram do mapa (OpenStreetMap)'
    : reading.origin==='player'
     ? 'Construído por você nesta partida'
     : 'Nada construído aqui ainda';
   card.replaceChildren(heading,rows,source);
   card.hidden=false;
   // A card on a phone belongs to the bottom edge, where the stylesheet already put it; on a larger screen it follows
   // the touch, kept inside the window by the same rule the floating screens use.
   if(view&&!root.classList.contains('sheets-sheet')){
   // The card follows the touch, kept inside the window and clear of whatever the shell keeps at the edges.
   const rail=parseFloat(view.getComputedStyle(root).getPropertyValue('--rail'))||0;
   card.style.left=`${Math.max(8+rail,Math.min(at.x+12,view.innerWidth-card.offsetWidth-8))}px`;
    card.style.top=`${Math.max(8,Math.min(at.y+12,view.innerHeight-card.offsetHeight-8))}px`;
   }else{
    card.style.left='';
    card.style.top='';
   }
  },
  destroy(){
   if(!card)return;
   card.hidden=true;
   card.replaceChildren();
  },
 };
}
