// Micro-benchmark for the commit/save cost of a live world (docs/world-protocol.md). It drives a host session through
// ticks over worlds of 50, 200 and 800 managed regions, with the identity memo on and off, and prints ms per commit
// and ms per save (the canonical save text and the durable identity). The memo may not move a single byte: it only
// remembers the canonical fragment and the address of an object that the immutable core keeps identical, so the work
// a later commit repeats is the work it never does again.
//
//   npx tsx tools/bench-commit.ts [steps]
import {createGame} from '../src/core/commands';
import {adopt} from '../src/core/world';
import {encodeSave} from '../src/core/snapshot';
import {durableJson,setMemoEnabled} from '../src/core/protocol';
import {RULES_VERSION} from '../src/core/model';
import type {BaseChunk,Cell,GameState,ViewState} from '../src/core/model';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {createWorldRepository} from '../src/session/world-repository';
import {createHostSession} from '../src/session/host-session';
import {importLegacy} from '../src/session/world-bundle';
import type {JsonValue} from '../src/world/model';
import {isRecord} from '../src/core/guards';
import type {IdentityProof} from '../src/world/permissions';
import type {MapSource} from '../src/session/ports';
import type {WorldCodec} from '../src/world/ports';
import type {SessionTransport} from '../src/session/multiplayer-ports';

const NOW='2026-10-03T12:00:00Z';
const view:ViewState={x:12.5,y:-4,zoom:1.5,speed:1,place:'Victoria'};
const identity:IdentityProof={kind:'identity',principal:{scheme:'local',id:'host'},sessionKey:'0'.repeat(64),scope:{worldId:'bench',branchId:'main',sessionId:'bench',notBefore:'2026-01-01T00:00:00Z',notAfter:'2027-01-01T00:00:00Z'},delegation:{algorithm:'Ed25519',key:'0'.repeat(64),value:'0'.repeat(128)}};
// Each region gets its own cell array, so nothing is shared between regions by accident: the memo can only reuse a
// region across commits, which is what the memo is actually for. The cells stay sparse (mostly bare land) so a world
// of 800 regions is still under the 4M-node limit the strict reader enforces on a stored snapshot.
function makeCells():Cell[]{
 return Array.from({length:1024},(_,index)=>{
  const y=Math.floor(index/32),x=index%32;
  if(y%7===0)return {terrain:'land',road:true};
  if(y%7===3)return {terrain:'land',building:'residential',stage:1+(x%3)};
  if(x>26)return {terrain:'water'};
  return {terrain:'land'};
 });
}
const regionOf=(index:number):BaseChunk=>({id:`${index}:0`,source:'bench',normalizerVersion:1,cells:makeCells()});
function stateWith(count:number):GameState{
 const game=createGame('bench',7,regionOf(0));
 const chunks={...game.chunks};
 for(let index=1;index<count;index+=1)chunks[`${index}:0`]=adopt(regionOf(index));
 return {...game,chunks};
}
function countingCodec():{codec:WorldCodec;baseAddresses:()=>number}{
 const jcs=createJcsCodec();
 let baseAddresses=0;
 return {
  baseAddresses:()=>baseAddresses,
  codec:{encode:(value:JsonValue)=>{if(isRecord(value)&&value['kind']==='base-chunk')baseAddresses+=1;return jcs.encode(value);}},
 };
}
type Sample={msCommit:number;msSave:number;msIdentity:number;baseAddressesPerCommit:number;bytes:number};
async function run(count:number,memo:boolean,steps:number):Promise<Sample>{
 const counter=countingCodec(),hasher=bytesHasher();
 const repository=createWorldRepository({storage:createWorldMemoryStorage(),codec:counter.codec,hasher,memo});
 const imported=await importLegacy({version:1,state:stateWith(count),view},hasher,counter.codec);
 if(!imported.ok)throw new Error(imported.error.message);
 const created=await repository.create(imported.value);
 if(!created.ok)throw new Error(created.error.message);
 const transport:SessionTransport={send:async()=>{},subscribe:()=>()=>{}};
 const bases:MapSource={loadChunk:async id=>({id,source:'bench',normalizerVersion:1,cells:makeCells()}),attribution:{text:'bench',url:'https://example.test'}};
 const host=createHostSession({repository,transport,peer:'local',head:created.value,identity,grants:[],rules:{family:'city',version:RULES_VERSION},bases,verifier:{verify:async()=>true},codec:counter.codec,hasher,now:()=>NOW,sessionId:'bench',epoch:1,peers:[],memo});
 // Warm-up: the boot checkout and the first commit populate whatever the memo will hold.
 const warm=await host.step();
 if(!warm.ok)throw new Error(warm.error.message);
 let commitNanos=0,saveNanos=0,identityNanos=0,addresses=0,bytes=0;
 for(let step=0;step<steps;step+=1){
  const before=counter.baseAddresses();
  const started=process.hrtime.bigint();
  const committed=await host.step();
  commitNanos+=Number(process.hrtime.bigint()-started);
  if(!committed.ok)throw new Error(committed.error.message);
  addresses+=counter.baseAddresses()-before;
  const point=await host.checkpoint();
  const save:{version:1;state:GameState;view:ViewState}={version:1,state:point.state,view};
  const saveStart=process.hrtime.bigint();
  bytes=encodeSave(save).length;
  saveNanos+=Number(process.hrtime.bigint()-saveStart);
  const identityStart=process.hrtime.bigint();
  durableJson(point.state);
  identityNanos+=Number(process.hrtime.bigint()-identityStart);
 }
 return {msCommit:commitNanos/1e6/steps,msSave:saveNanos/1e6/steps,msIdentity:identityNanos/1e6/steps,baseAddressesPerCommit:addresses/steps,bytes};
}
const steps=Math.max(1,Number(process.argv[2]??4));
const sizes=[50,200,800];
const rows:string[]=[];
for(const count of sizes){
 for(const memo of [false,true]){
  setMemoEnabled(memo);
  const sample=await run(count,memo,steps);
  rows.push(`trechos=${String(count).padStart(3)} memo=${memo?'on ':'off'} commit=${sample.msCommit.toFixed(2).padStart(7)}ms save=${sample.msSave.toFixed(2).padStart(7)}ms identidade=${sample.msIdentity.toFixed(2).padStart(7)}ms bases/commit=${sample.baseAddressesPerCommit.toFixed(1).padStart(6)} estado=${(sample.bytes/1024/1024).toFixed(1)}MB`);
 }
}
setMemoEnabled(true);
process.stdout.write(`${rows.join('\n')}\n`);
