// The player-facing side of the local history: which version is open, whether it is saved on this device and the
// checkpoints behind it. The panel builds its own markup so the composition in main.ts only wires the four flows the
// plan asks for — Criar versão, Exportar, Importar e Histórico — and every string the player reads is Portuguese,
// with the states the spec names ("Salvo neste dispositivo").
export type HistoryEntry = {generation:number;hash:string;label:string;current:boolean};
export type CompareOption = {hash:string;label:string};
export type CompareInfo = {summary:string;regions:readonly {id:string;label:string}[]};
export type HistoryInfo = {worldId:string;branchId:string;status:string;entries:readonly HistoryEntry[];message:string;compareOptions:readonly CompareOption[];compare:CompareInfo|null};
export type HistoryActions = {
 onCreateVersion(name:string):void;
 onExport():void;
 onImport(file:File):void;
 onBranch(branchId:string):void;
 onCompare(commitHash:string):void;
 onRegion(chunkId:string):void;
};
export type WorldHistoryPanel = {
 update(info:HistoryInfo):void;
 branches(ids:readonly string[],selected:string):void;
 destroy():void;
};
export function createWorldHistory(root:HTMLElement,actions:HistoryActions):WorldHistoryPanel {
 const doc=root.ownerDocument;
 const make=(tag:string,className?:string,text?:string):HTMLElement=>{
  const node=doc.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=text;
  return node;
 };
 const button=(text:string):HTMLButtonElement=>{
  const node=doc.createElement('button');
  node.type='button';
  node.textContent=text;
  return node;
 };
 const panel=make('section','panel');
 panel.id='panel-history';
 panel.dataset.panel='history';
 panel.setAttribute('aria-label','Versões da cidade');
 // A corner of the hud of its own: the player drags it like every other card and the hud remembers where it stayed.
 panel.style.left='8px';
 panel.style.top='238px';
 panel.style.width='min(320px,calc(100vw - 16px))';
 const head=make('header','panel-head');
 head.dataset.dragHandle='';
 const title=make('h2','panel-title','Versões');
 const collapse=button('▾');
 collapse.className='panel-close';
 collapse.dataset.close='';
 collapse.setAttribute('aria-expanded','true');
 collapse.setAttribute('aria-label','Minimizar painel Versões');
 collapse.title='Minimizar painel';
 head.append(title,collapse);
 const body=make('div','panel-body');
 body.dataset.panelBody='';
 const versionRow=make('p','history-version');
 const versionLabel=make('label',undefined,'Versão');
 versionLabel.setAttribute('for','history-branch');
 const branches=doc.createElement('select');
 branches.id='history-branch';
 branches.setAttribute('aria-label','Versões guardadas neste dispositivo');
 versionRow.append(versionLabel,branches);
 const status=make('p');
 status.id='history-status';
 const message=make('p');
 message.id='history-message';
 message.setAttribute('role','status');
 message.hidden=true;
 const actionsRow=make('div','history-actions');
 const nameLabel=make('label',undefined,'Nova versão');
 nameLabel.setAttribute('for','history-name');
 const nameInput=doc.createElement('input');
 nameInput.id='history-name';
 nameInput.value='experimento';
 nameInput.autocomplete='off';
 const createButton=button('Criar versão');
 const exportButton=button('Exportar');
 const importButton=button('Importar');
 const fileInput=doc.createElement('input');
 fileInput.type='file';
 fileInput.id='history-file';
 fileInput.accept='.json,application/json';
 fileInput.hidden=true;
 actionsRow.append(nameLabel,nameInput,createButton,exportButton,importButton,fileInput);
 const checkpoints=make('ol','history-checkpoints');
 // Comparing two versions is a read-only review: the player picks another checkpoint of this branch and sees how many
 // cells came from the real data, how many are their own work and what redoing that work would cost. A region button
 // moves the camera to it, so the difference is visible in the city and not only in the panel.
 const compareRow=make('div','history-compare');
 const compareLabel=make('label',undefined,'Comparar com');
 compareLabel.setAttribute('for','history-compare-choice');
 const compareSelect=doc.createElement('select');
 compareSelect.id='history-compare-choice';
 compareSelect.setAttribute('aria-label','Versão do histórico para comparar');
 const compareButton=button('Comparar');
 compareRow.append(compareLabel,compareSelect,compareButton);
 const compareSummary=make('p');
 compareSummary.id='history-compare-summary';
 compareSummary.hidden=true;
 const compareRegions=make('div','history-compare-regions');
 body.append(versionRow,status,message,actionsRow,checkpoints,compareRow,compareSummary,compareRegions);
 panel.append(head,body);
 root.append(panel);
 const onCreate=()=>actions.onCreateVersion(nameInput.value);
 const onExport=()=>actions.onExport();
 const onImport=()=>fileInput.click();
 const onFile=()=>{
  const chosen=fileInput.files?.[0];
  if(chosen)actions.onImport(chosen);
  fileInput.value='';
 };
 const onBranch=()=>actions.onBranch(branches.value);
 const onCompare=()=>{if(compareSelect.value)actions.onCompare(compareSelect.value);};
 // The select keeps a choice the history still offers instead of jumping back to the first option on every refresh.
 let chosen='';
 createButton.addEventListener('click',onCreate);
 exportButton.addEventListener('click',onExport);
 importButton.addEventListener('click',onImport);
 fileInput.addEventListener('change',onFile);
 branches.addEventListener('change',onBranch);
 compareButton.addEventListener('click',onCompare);
 return {
  update(info){
   status.textContent=`${info.worldId}/${info.branchId} · ${info.status}`;
   message.textContent=info.message;
   message.hidden=!info.message;
   checkpoints.replaceChildren(...info.entries.map(entry=>{
    const item=make('li',entry.current?'current':undefined,`#${entry.generation} ${entry.hash.slice(0,7)} ${entry.label}`);
    return item;
   }));
   if(!info.compareOptions.some(option=>option.hash===chosen))chosen=info.compareOptions[0]?.hash??'';
   compareSelect.replaceChildren(...info.compareOptions.map(option=>{
    const item=doc.createElement('option');
    item.value=option.hash;
    item.textContent=option.label;
    item.selected=option.hash===chosen;
    return item;
   }));
   compareSelect.disabled=!info.compareOptions.length;
   compareButton.disabled=!info.compareOptions.length;
   compareSummary.textContent=info.compare?.summary??'';
   compareSummary.hidden=!info.compare;
   compareRegions.replaceChildren(...(info.compare?.regions??[]).map(region=>{
    const open=button(region.label);
    open.addEventListener('click',()=>actions.onRegion(region.id));
    return open;
   }));
  },
  branches(ids,selected){
   const options=ids.length?ids:[''];
   branches.replaceChildren(...options.map(id=>{
    const option=doc.createElement('option');
    option.value=id;
    option.textContent=id||'—';
    option.selected=id===selected;
    return option;
   }));
  },
  destroy(){
   createButton.removeEventListener('click',onCreate);
   exportButton.removeEventListener('click',onExport);
   importButton.removeEventListener('click',onImport);
   fileInput.removeEventListener('change',onFile);
   branches.removeEventListener('change',onBranch);
   compareButton.removeEventListener('click',onCompare);
   panel.remove();
  },
 };
}
// An exported world leaves the browser as a file the player can keep, send to a friend or open on another device.
export function downloadBundle(name:string,bytes:Uint8Array,doc:Document):void {
 const url=URL.createObjectURL(new Blob([bytes.slice()],{type:'application/json'}));
 const link=doc.createElement('a');
 link.href=url;
 link.download=name;
 doc.body.append(link);
 link.click();
 link.remove();
 // Revoking immediately can cancel a download in some browsers; the object URL is released once it had its chance.
 setTimeout(()=>URL.revokeObjectURL(url),10_000);
}
export async function readBundleFile(file:File):Promise<Uint8Array> {
 return new Uint8Array(await file.arrayBuffer());
}
