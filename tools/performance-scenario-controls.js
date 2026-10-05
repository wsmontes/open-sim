// Local QA only. Copy into a frozen production directory and explicitly insert its script tag.
const scenes=[['Downtown',49.283,-123.121],['TransLink',49.276,-123.124],['Industrial',49.281,-123.098],['Regional highway',49.327,-123.112],['North Shore',49.338,-123.075],['False Creek',49.273,-123.12],['Canada Place',49.29,-123.112],['BC Ferries',49.378,-123.3],['YVR',49.19,-123.185],['Reproduction',49.276,-123.124]];
const panel=document.createElement('aside');panel.style.cssText='position:fixed;left:12px;top:52px;z-index:99;background:#eef0e9;padding:8px;color:#18332d;font:12px sans-serif;max-width:270px';
panel.innerHTML='<button id="perf-start">Medir produção · 10 cenas</button><button id="perf-stop">Parar medição</button><p id="perf-status" role="status">Aguardando</p><pre id="perf-result" aria-hidden="true" style="display:none"></pre>';
document.body.append(panel);let ticket=0;const runs=[],status=panel.querySelector('#perf-status'),output=panel.querySelector('#perf-result'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const read=()=>JSON.parse(document.querySelector('#open-sim-frame-stats').textContent);
panel.querySelector('#perf-stop').onclick=()=>{ticket++;status.textContent='Interrompido';document.querySelector('[data-speed="0"]').click();};
panel.querySelector('#perf-start').onclick=async()=>{
 const mine=++ticket;runs.length=0;document.querySelector('[data-speed="1"]').click();document.querySelector('#hud-north').click();
 const manifest={url:location.href,viewport:{width:innerWidth,height:innerHeight},pixelRatio:devicePixelRatio,userAgent:navigator.userAgent,startedAt:new Date().toISOString(),warmupMs:15000,runMs:30000,speed:1,runs};
 for(const [scene,lat,lon] of scenes){if(mine!==ticket)return;const form=document.querySelector('#place-form');form.querySelector('[name=lat]').value=lat;form.querySelector('[name=lon]').value=lon;form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await wait(2000);if(mine!==ticket)return;
 document.querySelector('#hud-city').click();document.querySelector('#hud').removeAttribute('data-sheet');status.textContent=`${scene} · aquecendo`;await wait(15000);
 const coordinates=document.querySelector('#map-coordinates').textContent;if(!coordinates.includes(Math.abs(lat).toFixed(3))||!coordinates.includes(Math.abs(lon).toFixed(3))){status.textContent=`Coordenada inválida: ${scene} ${coordinates}`;return;}
 for(let run=1;run<=3;run++){if(mine!==ticket)return;status.textContent=`${scene} · ${run}/3`;const started=performance.now();await wait(30000);if(mine!==ticket)return;const stats=read(),samples=stats.samples.filter(s=>s.at>=started&&s.at<=performance.now());runs.push({scene,run,coordinates,elapsedMs:performance.now()-started,samples,agents:stats.mobility,cache:stats.buildings});output.textContent=JSON.stringify(manifest);}
 }
 status.textContent='Concluído · 30 medições';document.querySelector('[data-speed="0"]').click();
};
// Supplemental reproduction: the user's dense100m view at45degrees, not the50m suite default.
const reproductionButton=document.createElement('button');reproductionButton.textContent='Medir reprodução ·100m';reproductionButton.id='perf-reproduction';panel.prepend(reproductionButton);
reproductionButton.onclick=async()=>{
 const mine=++ticket;runs.length=0;document.querySelector('[data-speed="1"]').click();const form=document.querySelector('#place-form');form.querySelector('[name=lat]').value='49.276';form.querySelector('[name=lon]').value='-123.124';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await wait(2000);document.querySelector('#hud-city').click();document.querySelector('#hud-north').click();await wait(1500);
 for(let i=0;i<12&&document.querySelector('#map-scale-label').textContent!=='100 m';i++){document.querySelector('#hud-zoom-out').click();await wait(500);}
 for(let i=0;i<3;i++){document.querySelector('#hud-rotate-right').click();await wait(500);}
 document.querySelector('#hud').removeAttribute('data-sheet');status.textContent='Reprodução100m · aquecendo';await wait(15000);if(mine!==ticket)return;
 const coordinates=document.querySelector('#map-coordinates').textContent,scale=document.querySelector('#map-scale-label').textContent;if(scale!=='100 m'||!coordinates.includes('49.276')||!coordinates.includes('123.124')){status.textContent=`Reprodução inválida: ${coordinates} ${scale}`;return;}
 const manifest={url:location.href,viewport:{width:innerWidth,height:innerHeight},pixelRatio:devicePixelRatio,startedAt:new Date().toISOString(),warmupMs:15000,runMs:30000,speed:1,rotationDegrees:45,scale,runs};
 for(let run=1;run<=3;run++){const started=performance.now();status.textContent=`Reprodução100m · ${run}/3`;await wait(30000);if(mine!==ticket)return;const stats=read();runs.push({scene:'Reproduction100m',run,coordinates,elapsedMs:performance.now()-started,samples:stats.samples.filter(s=>s.at>=started&&s.at<=performance.now()),agents:stats.mobility,cache:stats.buildings});output.textContent=JSON.stringify(manifest);}
 status.textContent='Concluído · reprodução100m';document.querySelector('[data-speed="0"]').click();
};
const journeyButton=document.createElement('button');journeyButton.id='perf-journeys';journeyButton.textContent='Verificar20viagens';panel.prepend(journeyButton);
journeyButton.onclick=async()=>{
 const mine=++ticket;const journeys=[];document.querySelector('[data-speed="1"]').click();
 const manifest={url:location.href,viewport:{width:innerWidth,height:innerHeight},startedAt:new Date().toISOString(),journeys};
 for(let i=0;i<20;i++){if(mine!==ticket)return;const [scene,lat,lon]=scenes[i%scenes.length];status.textContent=`Viagem${i+1}/20 · ${scene}`;const started=performance.now(),form=document.querySelector('#place-form');form.querySelector('[name=lat]').value=lat;form.querySelector('[name=lon]').value=lon;form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await wait(2200);document.querySelector('#hud-city').click();document.querySelector('#hud').removeAttribute('data-sheet');await wait(2200);if(mine!==ticket)return;const stats=read();journeys.push({scene,index:i+1,coordinates:document.querySelector('#map-coordinates').textContent,samples:stats.samples.filter(s=>s.at>=started),agents:stats.mobility,cache:stats.buildings});output.textContent=JSON.stringify(manifest);}
 document.querySelector('[data-speed="0"]').click();await wait(2000);const before=read();await wait(2000);const after=read();manifest.paused={before:before.frames,after:after.frames};output.textContent=JSON.stringify(manifest);status.textContent='Concluído ·20viagens e pausa';
};
