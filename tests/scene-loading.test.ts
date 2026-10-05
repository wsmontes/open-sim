// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {createSceneLoading} from '../src/browser/scene-loading';
it('waits for an actually presented city and keeps subsequent loading nonblocking',()=>{
 const element=document.createElement('aside'),loading=createSceneLoading(element),input={sessionReady:false,pictureReady:false,mapLoading:true,preparing:true,error:false};
 loading.update(input);expect(element.hidden).toBe(false);expect(element.textContent).toContain('Abrindo');expect(element.dataset.mode).toBe('initial');
 loading.update({...input,sessionReady:true});expect(element.textContent).toContain('Carregando cidade');
 loading.update({...input,sessionReady:true,mapLoading:false});expect(element.textContent).toContain('Preparando');expect(element.hidden).toBe(false);
 loading.update({...input,sessionReady:true,pictureReady:true,mapLoading:false,preparing:false});expect(element.hidden).toBe(true);
 loading.update({...input,sessionReady:true,pictureReady:false});expect(element.dataset.mode).toBe('update');expect(element.textContent).toContain('Atualizando');
});
it('shows an actionable error before first picture and allows recovery',()=>{
 const element=document.createElement('aside'),loading=createSceneLoading(element),input={sessionReady:true,pictureReady:false,mapLoading:false,preparing:false,error:true};
 loading.update(input);expect(element.textContent).toContain('Tentar novamente');expect(element.hidden).toBe(false);
 loading.update({...input,error:false,mapLoading:true});expect(element.textContent).toContain('Carregando');
 loading.update({...input,error:false,pictureReady:true});expect(element.hidden).toBe(true);
});
