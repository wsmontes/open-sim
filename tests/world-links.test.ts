import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {createWorldCard,readWorldCard,worldCardDocument,worldCardText} from '../src/adapters/social/world-card';
import type {PublicWorldInfo} from '../src/adapters/social/world-card';
import {createGame} from '../src/core/commands';
import {blank} from './fixtures/world';
import {failed,ok} from '../src/world/model';
import type {Head,JsonValue,ObjectRef,WorldResult} from '../src/world/model';
import type {GameState} from '../src/core/model';
import {checkWorldLink,forwardWorldLink,resolveWorldLink} from '../src/world/world-links';
import type {ObjectResolver,PublicCapability,WorldLink} from '../src/world/world-links';

const codec=createJcsCodec(),hasher=bytesHasher();
const ACTOR='did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const WORLD={worldId:'victoria',branchId:'main'};
// A synthetic world, addressed the way the repository addresses one: a state object, a tree that points at it and a
// commit that points at the tree. A link is resolved against these bytes, so the fixture is real content, not a mock.
async function tinyWorld(world=WORLD){
 const state=createGame(world.worldId,3,blank('9:9'));
 const snapshot:JsonValue={kind:'city-state',state:state as unknown as JsonValue};
 const stateRef=await hasher.ref(codec.encode(snapshot));
 const definition:JsonValue={worldId:world.worldId,branchId:world.branchId,origin:{kind:'new'},profiles:['city'],rules:{family:'city',version:1}};
 const tree:JsonValue={kind:'world-tree',definition,terms:[],state:stateRef as unknown as JsonValue,attached:[]};
 const treeRef=await hasher.ref(codec.encode(tree));
 const commit:JsonValue={kind:'world-commit',parents:[],tree:treeRef as unknown as JsonValue,generation:1,rules:{family:'city',version:1},datasets:[],accepted:[]};
 const commitRef=await hasher.ref(codec.encode(commit));
 const head:Head={...world,commit:commitRef,generation:1};
 return {state,snapshot,stateRef,tree,treeRef,commit,commitRef,head,definition};
}

type TinyWorld= Awaited<ReturnType<typeof tinyWorld>>;
type Copy={id:string;transport:string;objects:Map<string,JsonValue>;head:Head|null;down?:boolean};
// One copy of a world, holding one or more versions: what it holds, what it answers as its head, and whether it is up.
// The resolver owns no policy — deciding which copy is good enough is the job of `resolveWorldLink`, which is what these
// tests are about.
function copyOf(id:string,transport:string,versions:readonly TinyWorld[],holding:{commit?:boolean;tree?:boolean;state?:boolean;head?:boolean}={}):Copy{
 const objects=new Map<string,JsonValue>();
 for(const version of versions){
  if(holding.commit!==false)objects.set(version.commitRef.hash,version.commit);
  if(holding.tree!==false)objects.set(version.treeRef.hash,version.tree);
  if(holding.state!==false)objects.set(version.stateRef.hash,version.snapshot);
 }
 const newest=versions[versions.length-1]!;
 return {id,transport,objects,head:holding.head===false?null:newest.head};
}
// The same branch one version later: enough for the resolution, which answers with addresses and never re-derives rules.
async function movedVersion(world:TinyWorld):Promise<TinyWorld>{
 const state={...world.state,revision:world.state.revision+1,money:world.state.money-10};
 const snapshot:JsonValue={kind:'city-state',state:state as unknown as JsonValue};
 const stateRef=await hasher.ref(codec.encode(snapshot));
 const definition:JsonValue={worldId:'victoria',branchId:'main',origin:{kind:'new'},profiles:['city'],rules:{family:'city',version:1}};
 const tree:JsonValue={kind:'world-tree',definition,terms:[],state:stateRef as unknown as JsonValue,attached:[]};
 const treeRef=await hasher.ref(codec.encode(tree));
 const commit:JsonValue={kind:'world-commit',parents:[world.commitRef as unknown as JsonValue],tree:treeRef as unknown as JsonValue,generation:2,rules:{family:'city',version:1},datasets:[],accepted:[`p.1.movido@${'a'.repeat(64)}`]};
 const commitRef=await hasher.ref(codec.encode(commit));
 return {...world,state,snapshot,stateRef,tree,treeRef,commit,commitRef,head:{worldId:'victoria',branchId:'main',commit:commitRef,generation:2}};
}
// The resolver answers what each copy has and records the order it was asked, so a test can see that a fixed link never
// asks for a moving head and that the origin is preferred over a mirror.
function resolverOf(entries:readonly Copy[],log:string[]=[]):ObjectResolver&{log:string[]}{
 return {
  log,
  copies:()=>entries.map(entry=>({copy:entry.id,transport:entry.transport})),
  async head(copy,world){
   log.push(`head:${copy}`);
   const found=entries.find(entry=>entry.id===copy);
   if(!found||found.down)return failed('NOT_FOUND',`cópia ${copy} indisponível`);
   void world;
   return ok(found.head);
  },
  async object(copy,ref:ObjectRef){
   log.push(`object:${copy}`);
   const found=entries.find(entry=>entry.id===copy);
   if(!found||found.down)return failed('NOT_FOUND',`cópia ${copy} indisponível`);
   return ok(found.objects.get(ref.hash)??null);
  },
 };
}

const linkOf=(over:Partial<WorldLink>={}):WorldLink=>({
 kind:'world-link',version:1,id:'urn:opensim:link:rua-nova',world:WORLD,
 target:{kind:'branch'},arrival:{kind:'view',uri:'osim://earth/ca/bc/victoria?timeline=osim:timeline:earth-main'},
 capabilities:[],actor:ACTOR,sources:[{copy:'relay',transport:'nostr'}],...over,
});

// A resolution with no copy at all: what the walk itself decides, before any object is in hand.
const visiting=(value:WorldLink):Promise<WorldResult<unknown>>=>resolveWorldLink(value,resolverOf([]));

test('a link says whether it is a fixed version or a branch that moves, and refuses to be both',async()=>{
 const world=await tinyWorld();
 const fixed=linkOf({target:{kind:'commit',commit:world.commitRef}});
 expect(checkWorldLink(fixed)).toEqual({ok:true,value:fixed});
 // A moving link carries no commit and a fixed one carries exactly one; a document that claims both is refused instead
 // of being read as whichever field the reader happens to look at first.
 expect(checkWorldLink({...fixed,id:'urn:opensim:link:mentira',target:{kind:'branch',commit:world.commitRef}})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(checkWorldLink({...fixed,id:'urn:opensim:link:sem-commit',target:{kind:'commit'}})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 // A closed registry: a field nobody declared does not ride along, and neither does a private one.
 expect(checkWorldLink({...fixed,id:'urn:opensim:link:extra',grant:{issuer:ACTOR}})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(checkWorldLink({...fixed,id:'urn:opensim:link:vista',arrival:{kind:'view',uri:'osim://earth?server=example.org'}})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(checkWorldLink({...fixed,id:'card-1'})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(await visiting(fixed)).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
 // Having the commit is not having the world: a visit needs the version behind it, and a copy without the tree or the
 // state is a copy that cannot be entered.
 expect(await resolveWorldLink(fixed,resolverOf([copyOf('relay','nostr',[world],{tree:false,state:false})]))).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
},10000);

test('a moving link lands where the branch is, and a fixed one lands where it points',async()=>{
 const world=await tinyWorld();
 const moved=await movedVersion(world);
 const relay=copyOf('relay','nostr',[world,moved]);
 // The branch moved to generation 2; the fixed link still opens generation 1, and the moving one opens the new version.
 const fixedLog:string[]=[];
 const fixed=await resolveWorldLink(linkOf({target:{kind:'commit',commit:world.commitRef}}),resolverOf([relay],fixedLog));
 expect(fixed).toMatchObject({ok:true,value:{moving:false,commit:world.commitRef,generation:1,write:false,servedBy:'relay',degraded:false}});
 expect(fixedLog.filter(entry=>entry.startsWith('head:'))).toEqual([]);
 expect(fixedLog).toEqual(['object:relay','object:relay','object:relay']);
 const moving=await resolveWorldLink(linkOf(),resolverOf([relay]));
 expect(moving).toMatchObject({ok:true,value:{moving:true,commit:moved.commitRef,generation:2}});
 expect(world.stateRef.bytes).toBeGreaterThan(0);
 expect(moved.treeRef.bytes).toBeGreaterThan(0);
});

test('resolving a link is an invitation to look, never a permission to build',async()=>{
 const world=await tinyWorld();
 const declared:PublicCapability={issuer:ACTOR,subject:'did:key:guest',entity:'osim:entity:house-42',component:'city.zoning',actions:['build','component']};
 const resolver=resolverOf([copyOf('relay','nostr',[world])]);
 const resolved=await resolveWorldLink(linkOf({capabilities:[declared]}),resolver);
 expect(resolved).toMatchObject({ok:true,value:{role:'visitor',write:false,capabilities:[declared]}});
 if(!resolved.ok)return;
 // Nothing in a visit target authorizes anything: the capability is the issuer's declaration, and writing still needs
 // a grant checked by `authorize` against the version the writer saw.
 expect(Object.keys(resolved.value)).not.toContain('grant');
 expect(Object.keys(resolved.value)).not.toContain('proof');
 expect(JSON.stringify(resolved.value)).not.toContain('secret');
 expect(await resolveWorldLink({...linkOf({id:'urn:opensim:link:pedido'}),role:'owner'} as unknown as WorldLink,resolver)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
});

test('an origin that is down is survived by any copy that actually has the version',async()=>{
 const world=await tinyWorld();
 const origin={...copyOf('relay','nostr',[world]),down:true};
 const mirror=copyOf('matrix','matrix',[world]);
 const link=linkOf({sources:[{copy:'relay',transport:'nostr'},{copy:'matrix',transport:'matrix'}]});
 const resolved=await resolveWorldLink(link,resolverOf([origin,mirror]));
 expect(resolved).toMatchObject({ok:true,value:{servedBy:'matrix',unavailable:['relay'],degraded:true}});
 // A copy that answers a head but cannot produce the objects behind it is not a copy of this world, and neither is one
 // that answers with another branch or with a head its own commit does not confirm.
 const halfHead=resolverOf([copyOf('relay','nostr',[world],{tree:false,state:false}),copyOf('matrix','matrix',[world],{tree:false,state:false})]);
 expect(await resolveWorldLink(link,halfHead)).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
 const otherBranch=resolverOf([{...copyOf('relay','nostr',[world]),head:{...world.head,branchId:'outra'}}]);
 expect(await resolveWorldLink(link,otherBranch)).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 const lying=resolverOf([{...copyOf('relay','nostr',[world]),head:{...world.head,generation:9}}]);
 expect(await resolveWorldLink(link,lying)).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 expect(await resolveWorldLink(link,resolverOf([origin]))).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
});

test('a bridge forwards a link without inventing a second identity for it, and stops at the hop limit',()=>{
 const original=linkOf();
 const first=forwardWorldLink(original,{bridge:'matrix:@ponte:servidor',maxHops:2});
 expect(first).toMatchObject({ok:true,value:{origin:original.id,href:`matrix:@ponte:servidor#${original.id}`,hops:1,bridge:'matrix:@ponte:servidor',duplicate:false}});
 if(!first.ok)return;
 expect(first.value.link.bridge).toEqual({bridge:'matrix:@ponte:servidor',origin:original.id,hops:1});
 expect(first.value.link.id).toBe(original.id);
 // The same bridge seeing the same original again does not publish it twice, and a mirror of that bridge is a second
 // bridge, which is how a loop is caught: the hops limit, not a guess about who is a loop.
 const again=forwardWorldLink(first.value.link,{bridge:'matrix:@ponte:servidor',maxHops:2});
 expect(again).toMatchObject({ok:true,value:{duplicate:true,href:`matrix:@ponte:servidor#${original.id}`}});
 const seen=forwardWorldLink(original,{bridge:'matrix:@ponte:servidor',maxHops:2,seen:[`matrix:@ponte:servidor#${original.id}`]});
 expect(seen).toMatchObject({ok:true,value:{duplicate:true}});
 const second=forwardWorldLink(first.value.link,{bridge:'nostr:ponte-do-relay',maxHops:2});
 expect(second).toMatchObject({ok:true,value:{hops:2,origin:original.id,duplicate:false}});
 if(!second.ok)return;
 expect(forwardWorldLink(second.value.link,{bridge:'matrix:@outra:servidor',maxHops:2})).toMatchObject({ok:false,error:{code:'LIMIT'}});
 expect(forwardWorldLink({...original,id:'urn:opensim:link:privado',grant:{}} as unknown as WorldLink,{bridge:'nostr:ponte',maxHops:2})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
});

test('the card publishes what it declares and refuses to carry anything else',async()=>{
 const world=await tinyWorld();
 const link=linkOf({target:{kind:'commit',commit:world.commitRef}});
 const info:PublicWorldInfo={
  id:'urn:opensim:card:victoria-1',
  world:WORLD,
  title:'Victoria sintética',
  summary:'Um trecho inventado para exercitar o cartão.',
  view:'osim://earth/ca/bc/victoria',
  actor:ACTOR,
  link,
  terms:[{source:'synthetic-terrain-v1',attribution:'Fixture sintética do repositório open-sim',license:'CC0-1.0'}],
  capabilities:[{issuer:ACTOR,entity:'osim:entity:house-42',component:'city.zoning',actions:['build']}],
  publishedAt:'2026-09-29T22:00:00Z',
  language:'pt-BR',
 };
 const card=createWorldCard(info);
 expect(Object.keys(card).sort()).toEqual(['actor','capabilities','id','kind','language','link','publishedAt','summary','terms','title','version','view','world']);
 const text=worldCardText(card);
 expect(text).toContain('osim://earth/ca/bc/victoria');
 expect(text).toContain(link.id);
 expect(text).toContain('CC0-1.0');
 expect(text).toContain('Fixture sintética do repositório open-sim');
 expect(text).toContain('não concede');
 expect(text).not.toMatch(/nsec1|privateKey|secretKey|-----BEGIN/);
 const document=worldCardDocument(card);
 expect(document).toMatchObject({type:'Note',id:card.id,attributedTo:ACTOR,published:'2026-09-29T22:00:00Z',content:text});
 // A card is shared by whoever decides to share it: the document addresses nobody, so importing it cannot mail a world
 // to a community by itself.
 expect(Object.keys(document as Record<string,JsonValue>)).not.toContain('to');
 expect(Object.keys(document as Record<string,JsonValue>)).not.toContain('cc');
 expect(JSON.stringify(document)).not.toMatch(/nsec1|privateKey|secretKey|-----BEGIN/);
});

test('a card refuses a key, a snapshot or a field it did not declare, instead of quietly dropping them',async()=>{
 const world=await tinyWorld();
 const base:PublicWorldInfo={id:'urn:opensim:card:1',world:WORLD,title:'Victoria',view:'osim://earth/ca/bc/victoria',actor:ACTOR,link:linkOf(),terms:[]};
 expect(()=>createWorldCard({...base,state:world.snapshot} as unknown as PublicWorldInfo)).toThrow(/state/);
 expect(()=>createWorldCard({...base,privateKey:'nsec1pg4v0k5m8zq9r3s2t7w6y4x2c8v0n8j2h5g3f' as unknown as undefined} as unknown as PublicWorldInfo)).toThrow(/privateKey/);
 expect(()=>createWorldCard({...base,grant:{issuer:ACTOR}} as unknown as PublicWorldInfo)).toThrow(/grant/);
 // The declared fields are read, so a key hidden inside one is still a key in a public document.
 expect(()=>createWorldCard({...base,summary:'chave: nsec1pg4v0k5m8zq9r3s2t7w6y4x2c8v0n8j2h5g3f'})).toThrow(/chave/i);
 expect(()=>createWorldCard({...base,summary:'-----BEGIN PRIVATE KEY-----'})).toThrow(/chave/i);
 expect(()=>createWorldCard({...base,view:'osim://earth?server=example.org'})).toThrow(/vista/i);
 expect(()=>createWorldCard({...base,id:'card-1'})).toThrow(/identificador/i);
 expect(()=>createWorldCard({...base,title:'   '})).toThrow(/título/i);
});

test('a card that arrives from somebody else is read by the same closed check',async()=>{
 const world=await tinyWorld();
 const card=createWorldCard({id:'urn:opensim:card:victoria',world:WORLD,title:'Victoria sintética',view:'osim://earth/ca/bc/victoria',actor:ACTOR,link:linkOf({target:{kind:'commit',commit:world.commitRef}}),terms:[{source:'synthetic-terrain-v1',license:'CC0-1.0'}]});
 const onTheWire:unknown=JSON.parse(JSON.stringify(card));
 expect(readWorldCard(onTheWire)).toEqual({ok:true,value:card});
 // Whatever arrived is checked exactly like what was built: a field nobody declared and a key hidden in the free text
 // are both refused, with the field named.
 expect(readWorldCard({...onTheWire as Record<string,unknown>,state:{chunks:{}}})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 const hidden=readWorldCard({...onTheWire as Record<string,unknown>,summary:'chave: nsec1pg4v0k5m8zq9r3s2t7w6y4x2c8v0n8j2h5g3f'});
 expect(hidden).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 if(!hidden.ok)expect(hidden.error.message).toMatch(/chave/i);
});

test('the core vocabulary, not a game action, is what a public capability may name',()=>{
 const base=linkOf();
 expect(checkWorldLink({...base,capabilities:[{issuer:ACTOR,actions:['set','merge']}]})).toMatchObject({ok:true});
 expect(checkWorldLink({...base,id:'urn:opensim:link:acao-inventada',capabilities:[{issuer:ACTOR,actions:['teleport']}]})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 // A role is not an action: it follows from what a session agreed, so a share file may not publish one as if it were.
 expect(checkWorldLink({...base,id:'urn:opensim:link:papel',capabilities:[{issuer:ACTOR,actions:['admin']}]})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(checkWorldLink({...base,id:'urn:opensim:link:sem-ator',capabilities:[{issuer:'zelador',actions:['build']}]})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
});

test('a visit target can be handed to another client without carrying the world with it',async()=>{
 const world=await tinyWorld();
 const resolved=await resolveWorldLink(linkOf(),resolverOf([copyOf('relay','nostr',[world])]));
 if(!resolved.ok)throw new Error(resolved.error.message);
 const checkpoint:GameState=world.state;
 const serialized=JSON.stringify(resolved.value);
 expect(serialized).toContain(world.commitRef.hash);
 expect(serialized).not.toContain(world.stateRef.hash);
 expect(serialized).not.toContain('"chunks"');
 expect(checkpoint.revision).toBe(0);
});
