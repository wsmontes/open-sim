export type CityLight='day'|'night';
const colors=new Map<string,string>();
export function cityColor(color:string,light:CityLight):string{
 if(light==='day'||!/^#[0-9a-f]{6}$/i.test(color))return color;
 const cached=colors.get(color);if(cached)return cached;
 const rgb=[1,3,5].map(i=>Number.parseInt(color.slice(i,i+2),16));
 const result=`#${rgb.map((v,i)=>Math.round(v*[.32,.40,.53][i]+[8,12,19][i]).toString(16).padStart(2,'0')).join('')}`;
 colors.set(color,result);return result;
}
export function lightContext(ctx:CanvasRenderingContext2D,light:CityLight):CanvasRenderingContext2D{
 if(light==='day')return ctx;
 const methods=new Map<PropertyKey,unknown>();
 return new Proxy(ctx,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;if(!methods.has(key))methods.set(key,value.bind(target));return methods.get(key);},set(target,key,value){return Reflect.set(target,key,(key==='fillStyle'||key==='strokeStyle')&&typeof value==='string'?cityColor(value,light):value,target);}});
}
