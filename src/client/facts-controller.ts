import type {CityFacts,FactsPort} from './facts';

// Latest query owns publication. Cache only successful replies; an offline failure can retry.
export function createFactsController(port:FactsPort,onFacts:(facts:CityFacts|null)=>void){
 let ticket=0;
 const cache=new Map<string,CityFacts>();
 const request=async(key:string,read:()=>Promise<CityFacts|null>)=>{
  const mine=++ticket;
  let found:CityFacts|null;
  try{found=cache.get(key)??await read();}catch{found=null;}
  if(found)cache.set(key,found);
  if(mine===ticket)onFacts(found);
 };
 return{
  named:(name:string)=>request(`name:${name}`,()=>port.named(name)),
  near:(lat:number,lon:number)=>request(`near:${lat}:${lon}`,()=>port.near(lat,lon)),
  lookup:(lat:number,lon:number,name?:string)=>request(`lookup:${name??''}:${lat}:${lon}`,async()=>{
   let found:CityFacts|null=null;
   if(name)try{found=await port.named(name);}catch{/* Coordinate lookup remains usable. */}
   return found??await port.near(lat,lon);
  }),
  dispose(){ticket++;cache.clear();},
 };
}
