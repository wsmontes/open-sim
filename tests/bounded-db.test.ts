import {expect,test,vi} from 'vitest';
import {boundedDb} from '../src/adapters/storage/bounded-db';

// A fake IDBFactory whose open request is driven by hand: the test decides when it succeeds, blocks or fails.
type FakeRequest={result:unknown;error:DOMException|null;onupgradeneeded?:()=>void;onsuccess?:()=>void;onerror?:()=>void;onblocked?:()=>void};
const fakeFactory=()=>{
 const requests:FakeRequest[]=[];
 const created:string[]=[];
 const closed:number[]=[];
 const db=(id:number)=>({objectStoreNames:{contains:(name:string)=>created.includes(name)},createObjectStore:(name:string)=>{created.push(name);},close:()=>{closed.push(id);},onversionchange:null as null|(()=>void)});
 const factory={open:()=>{const request:FakeRequest={result:db(requests.length),error:null};requests.push(request);return request;}} as unknown as IDBFactory;
 return {factory,requests,created,closed};
};
const options=(factory:IDBFactory)=>({name:'t',stores:['a','b'],factory,timeoutMs:50,subject:'O armazenamento local'});

test('the database is opened once, its stores are created on upgrade and later calls share the connection',async()=>{
 const fake=fakeFactory(),connect=boundedDb(options(fake.factory));
 const first=connect(),second=connect();
 expect(fake.requests).toHaveLength(1);
 fake.requests[0]!.onupgradeneeded!();
 fake.requests[0]!.onsuccess!();
 expect(await first).toBe(await second);
 expect(fake.created).toEqual(['a','b']);
});

test('a blocked open is reported in words and forgotten, so the next call tries again',async()=>{
 const fake=fakeFactory(),connect=boundedDb(options(fake.factory));
 const pending=connect();
 fake.requests[0]!.onblocked!();
 await expect(pending).rejects.toThrow('O armazenamento local está bloqueado por outra aba do jogo');
 void connect();
 expect(fake.requests).toHaveLength(2);
});

test('an open that never answers fails at the deadline, and a late success closes the connection it no longer needs',async()=>{
 vi.useFakeTimers();
 try{
  const fake=fakeFactory(),connect=boundedDb(options(fake.factory));
  const pending=connect();
  const refused=expect(pending).rejects.toThrow('O armazenamento local não respondeu');
  vi.advanceTimersByTime(50);
  await refused;
  fake.requests[0]!.onsuccess!();
  expect(fake.closed).toEqual([0]);
 }finally{vi.useRealTimers();}
});

test('an open error keeps the cause the browser gave',async()=>{
 const fake=fakeFactory(),connect=boundedDb(options(fake.factory));
 const pending=connect();
 const cause=new Error('quota');
 fake.requests[0]!.error=cause as unknown as DOMException;
 fake.requests[0]!.onerror!();
 await expect(pending).rejects.toBe(cause);
});

test('versionchange closes and forgets the cached connection',async()=>{
 const fake=fakeFactory(),connect=boundedDb(options(fake.factory));
 const first=connect();fake.requests[0]!.onsuccess!();const db=await first;
 db.onversionchange!({} as IDBVersionChangeEvent);const next=connect();
 expect(fake.requests).toHaveLength(2);fake.requests[1]!.onsuccess!();await next;
});
