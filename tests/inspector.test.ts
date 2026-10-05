// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {beforeEach,expect,test} from 'vitest';
import {createInspector} from '../src/surfaces/canvas/inspector';
import type {CellReading} from '../src/core/simulation';

// What the player gets when they touch the city. The card is read at a glance, so what it must not do matters as much
// as what it must: a factory with a row of "0 moradores", or a house whose origin is quietly attributed to the player,
// is worse than a card with fewer rows.
const hudMarkup=new DOMParser().parseFromString(readFileSync('index.html','utf8'),'text/html').querySelector('#hud')?.outerHTML??'';
const mount=()=>{
 document.body.innerHTML=hudMarkup;
 return document.getElementById('hud') as HTMLElement;
};
const reading=(over:Partial<CellReading>={}):CellReading=>({terrain:'land',occupied:false,residents:0,jobs:0,landValue:40,...over});
const shown=(_root:HTMLElement)=>{
 const card=document.getElementById('hud-inspector') as HTMLElement;
 return {
  hidden:card.hidden,
  title:card.querySelector('h3')?.textContent??null,
  rows:[...card.querySelectorAll('dt')].map(node=>node.textContent),
  values:[...card.querySelectorAll('dd')].map(node=>node.textContent),
  source:card.querySelector('.inspector-source')?.textContent??null,
 };
};
beforeEach(()=>{mount();});

test('the card says what is there, in the words the rest of the game uses',()=>{
 const root=mount();
 const inspector=createInspector(root);
 const at={x:10,y:10};
 inspector.show({cell:{x:3,y:4},reading:reading({building:'residential',stage:3,origin:'imported',occupied:true,residents:12,landValue:88}),at});
 expect(shown(root).title).toBe('Moradia · 3 andares');
 inspector.show({cell:{x:3,y:4},reading:reading({building:'residential',stage:1,occupied:true,residents:4}),at});
 expect(shown(root).title).toBe('Moradia · 1 andar');
 inspector.show({cell:{x:3,y:4},reading:reading({building:'residential',stage:0,origin:'player'}),at});
 expect(shown(root).title).toBe('Moradia · lote vazio');
 inspector.show({cell:{x:3,y:4},reading:reading({road:'avenue'}),at});
 expect(shown(root).title).toBe('Rua · avenida');
 inspector.show({cell:{x:3,y:4},reading:reading({terrain:'water',landValue:1}),at});
 expect(shown(root).title).toBe('Água');
 inspector.show({cell:{x:3,y:4},reading:reading({terrain:'green'}),at});
 expect(shown(root).title).toBe('Vegetação');
 inspector.destroy();
});

test('a row that would be about nothing is not there',()=>{
 const root=mount();
 const inspector=createInspector(root);
 const at={x:10,y:10};
 // A factory employs people and houses nobody: the card says the one, not both.
 inspector.show({cell:{x:1,y:1},reading:reading({building:'industrial',stage:2,origin:'player',occupied:true,jobs:20,landValue:30}),at});
 expect(shown(root).rows).toContain('Empregos');
 expect(shown(root).rows).not.toContain('Moradores');
 expect(shown(root).values[0]).toBe('20');
 // A road is a road: no residents, no jobs, just what it is and what the land under it is worth.
 inspector.show({cell:{x:1,y:1},reading:reading({road:'street'}),at});
 expect(shown(root).rows).toEqual(['Valor da terra','Quadra']);
 inspector.destroy();
});

test('the card tells the player where what they are looking at came from',()=>{
 const root=mount();
 const inspector=createInspector(root);
 const at={x:10,y:10};
 const sourceFor=(over:Partial<CellReading>)=> {
  inspector.show({cell:{x:2,y:2},reading:reading(over),at});
  return shown(root).source;
 };
 expect(sourceFor({building:'residential',stage:2,origin:'imported',occupied:true})).toContain('OpenStreetMap');
 expect(sourceFor({building:'residential',stage:2,origin:'player',occupied:true})).toContain('Construído por você');
 expect(sourceFor({})).toContain('Nada construído');
 inspector.destroy();
});

test('letting go of the city takes the card with it',()=>{
 const root=mount();
 const inspector=createInspector(root);
 inspector.show({cell:{x:1,y:1},reading:reading({road:'street'}),at:{x:5,y:5}});
 expect(shown(root).hidden).toBe(false);
 inspector.show(null);
 expect(shown(root).hidden).toBe(true);
 expect(shown(root).title).toBeNull();
 inspector.destroy();
});
