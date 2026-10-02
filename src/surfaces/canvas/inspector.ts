import type {CellCoord} from '../../core/model';
import type {CellReading} from '../../core/simulation';
import {cardText} from '../../presentation/card-text';

// What the player touched. It sits beside the touch — or, where there is no room for a card, along the bottom edge —
// and it says what is there and where the game knows it from. It is not a screen: it has no close button, because
// letting go of the city is what closes it. The words come from card-text.ts, shared with every other surface.
export type InspectorInfo = {cell:CellCoord;reading:CellReading;at:{x:number;y:number}};
export type Inspector = {show(info:InspectorInfo|null):void; destroy():void};

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
   const {at}=info,text=cardText(info.cell,info.reading);
   const heading=root.ownerDocument.createElement('h3');
   heading.textContent=text.title;
   const rows=root.ownerDocument.createElement('dl');
   for(const [label,value] of text.rows){
    const wrap=root.ownerDocument.createElement('div');
    const dt=root.ownerDocument.createElement('dt'),dd=root.ownerDocument.createElement('dd');
    dt.textContent=label;dd.textContent=value;
    wrap.append(dt,dd);
    rows.append(wrap);
   }
   const source=root.ownerDocument.createElement('p');
   source.className='inspector-source';
   source.textContent=text.source;
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
