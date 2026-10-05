export type SceneLoadingState={sessionReady:boolean;pictureReady:boolean;mapLoading:boolean;preparing:boolean;error:boolean;limited?:boolean;recovering?:boolean};
export function createSceneLoading(element:HTMLElement,onRetry:()=>void=()=>{}){
 let usable=false,last='';
 const message=element.querySelector<HTMLElement>('[data-loading-message]')??element.appendChild(element.ownerDocument.createElement('span'));
 let retry=element.querySelector<HTMLButtonElement>('[data-loading-retry]');
 if(!retry){retry=element.ownerDocument.createElement('button');retry.type='button';retry.textContent='Tentar novamente';element.append(retry);}
 retry.addEventListener('click',onRetry);
 return {update(state:SceneLoadingState){
  if(state.pictureReady)usable=true;
  const mode=usable?'update':'initial',text=state.recovering?'Recuperando mapa…':state.limited?'Detalhe reduzido para manter o mapa fluido.':state.error?(usable?'Parte da cidade não carregou.':'Não foi possível carregar a cidade.'):!state.sessionReady?'Abrindo cidade…':!usable?(state.mapLoading?'Carregando cidade…':'Preparando cidade…'):'Atualizando mapa…';
  const visible=!usable||state.mapLoading||state.preparing||state.error||state.limited||state.recovering,key=[mode,text,visible,state.error].join(':');if(key===last)return;last=key;
  element.dataset.mode=mode;element.dataset.error=String(state.error);element.hidden=!visible;message.textContent=text;retry!.hidden=!state.error;
 }};
}
