import {RULES_VERSION} from '../src/core/model';
import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {ed25519Verifier,generateSessionKeyPair,localIdentityProvider,signEd25519} from '../src/adapters/crypto/session-keys';
import type {KeyPair} from '../src/adapters/crypto/session-keys';
import {applyCommand,createGame} from '../src/core/commands';
import {commandFor} from '../src/session/multiplayer-ports';
import {blank} from './fixtures/world';
import {NETWORK_LIMITS} from '../src/world/wire';
import {actorId,authorize,controlFrom,grantBytes,identityBytes,intentFrom,negotiate,proposalBytes,roleFor,verifyGrant} from '../src/world/permissions';
import type {AuthorizationContext,Capabilities,Grant,IdentityProof,IdentityScope,Proposal} from '../src/world/permissions';
import type {Head,JsonValue} from '../src/world/model';

const codec=createJcsCodec(),hasher=bytesHasher(),verifier=ed25519Verifier();
const NOW='2026-09-29T12:00:00Z';
const ANA={scheme:'nostr',id:'npub1ana'};
const MAIN={worldId:'victoria',branchId:'main'};
const SESSION='sessao-1';
const head:Head={...MAIN,commit:{hash:'aa'.repeat(32),bytes:1},generation:7};
const scopeOf=(overrides:Partial<IdentityScope>={}):IdentityScope=>({...MAIN,sessionId:SESSION,notBefore:'2026-09-29T11:00:00Z',notAfter:'2026-09-29T13:00:00Z',...overrides});
const here=(x:number,y:number)=>({x:288+x,y:288+y});
const hex=(value:string)=>Uint8Array.from(value.match(/../g)??[],part=>parseInt(part,16));
// RFC 8032 §7.1 vectors: the seed, its public key, the message and the signature the standard prints.
const RFC8032=[
 {secretKey:'9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',publicKey:'d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',message:'',signature:'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'},
 {secretKey:'4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',publicKey:'3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',message:'72',signature:'92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'},
 {secretKey:'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',publicKey:'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',message:'af82',signature:'6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'},
];

const root=await generateSessionKeyPair(),session=await generateSessionKeyPair(),other=await generateSessionKeyPair();
const provider=localIdentityProvider({root,session,codec});
const bound=await provider.bindSession({principal:ANA,scope:scopeOf()});
if(!bound.ok)throw new Error(bound.error.message);
const identity=bound.value;

const capabilities=(overrides:Partial<Capabilities>={}):Capabilities=>({kind:'capabilities',worldProtocol:2,wireVersion:1,rules:{family:'city',version:RULES_VERSION},actions:['build','host'],namespaces:[{key:'cidade.transito',critical:true}],limits:NETWORK_LIMITS,...overrides});

async function proposalOf(overrides:Partial<Proposal>={},signer:KeyPair=session):Promise<Proposal>{
 const base:Proposal={worldProtocol:2,wireVersion:1,kind:'proposal',...MAIN,sessionId:SESSION,epoch:1,id:'proposta-1',principal:ANA,sessionKey:session.publicKey,observedHead:head.commit,intent:{type:'build',tool:'park',cells:[here(1,1)]},preconditions:{revision:0},costLimit:100,proof:{kind:'message',algorithm:'Ed25519',sessionKey:session.publicKey,signature:''}};
 const merged={...base,...overrides};
 return {...merged,proof:{kind:'message',algorithm:'Ed25519',sessionKey:merged.sessionKey,signature:await signEd25519(signer,proposalBytes(merged,codec))}};
}
async function grantOf(overrides:Partial<Grant>={}):Promise<Grant>{
 const base:Grant={kind:'grant',id:'concessao-1',principal:ANA,...MAIN,actions:['build','demolish','component','tick'],namespaces:['cidade.transito'],regions:['9:9'],spendLimit:1000,proof:{kind:'message',algorithm:'Ed25519',sessionKey:session.publicKey,signature:''}};
 const merged:Grant={...base,...overrides};
 // An override that is explicitly undefined removes the clause, the way an absent field does on the wire.
 for(const key of Object.keys(merged) as (keyof Grant)[]) if(merged[key]===undefined) delete merged[key];
 return {...merged,proof:{kind:'message',algorithm:'Ed25519',sessionKey:merged.proof.sessionKey,signature:await signEd25519(session,grantBytes(merged,codec))}};
}
function contextOf(overrides:Partial<AuthorizationContext>={}):AuthorizationContext{
 return {head,revision:0,epoch:1,now:NOW,identity,codec,hasher,verifier,marks:[],revokedGrants:[],chain:[],...overrides};
}
// The code of the refusal, or 'ACEITA' when the proposal was authorized despite the test expecting otherwise.
async function refusal(grant:Grant,proposal:Proposal,overrides:Partial<AuthorizationContext>={}):Promise<string>{
 const result=await authorize(grant,proposal,contextOf(overrides));
 return result.ok?'ACEITA':result.error.code;
}

test('Ed25519 matches the RFC 8032 vectors and refuses a tampered signature',async()=>{
 for(const [index,vector] of RFC8032.entries()){
  const pair:KeyPair={secretKey:vector.secretKey,publicKey:vector.publicKey};
  const message=hex(vector.message);
  expect(await signEd25519(pair,message)).toBe(vector.signature);
  const proof={kind:'message' as const,algorithm:'Ed25519' as const,sessionKey:vector.publicKey,signature:vector.signature};
  expect(await verifier.verify(proof,message)).toBe(true);
  const oneBit=`${proof.signature[0]==='0'?'1':'0'}${proof.signature.slice(1)}`;
  expect(await verifier.verify({...proof,signature:oneBit},message)).toBe(false);
  expect(await verifier.verify({...proof,signature:proof.signature.slice(0,126)},message)).toBe(false);
  expect(await verifier.verify({...proof,sessionKey:RFC8032[(index+1)%RFC8032.length]!.publicKey},message)).toBe(false);
  expect(await verifier.verify(proof,hex(`${vector.message}00`))).toBe(false);
 }
});

test('the short session key is delegated by the root key and only it signs messages',async()=>{
 expect(identity.sessionKey).toBe(session.publicKey);
 expect(identity.delegation.key).toBe(root.publicKey);
 expect(identity.delegation.algorithm).toBe('Ed25519');
 expect(identity.sessionKey).not.toBe(identity.delegation.key);
 expect(await verifier.verify(identity,identityBytes(identity,codec))).toBe(true);
 const grant=await grantOf();
 const proposal=await proposalOf();
 const rootSigned:Proposal={...proposal,proof:{kind:'message',algorithm:'Ed25519',sessionKey:root.publicKey,signature:await signEd25519(root,proposalBytes(proposal,codec))}};
 expect(await verifier.verify(rootSigned.proof,proposalBytes(rootSigned,codec))).toBe(true);
 expect(await refusal(grant,rootSigned)).toBe('SIGNATURE');
 expect(await refusal(grant,await proposalOf({},other))).toBe('SIGNATURE');
 expect(await refusal(grant,await proposalOf({sessionKey:other.publicKey}))).toBe('SIGNATURE');
});

test('a forged principal is refused even when the delegation itself verifies',async()=>{
 const localPrincipal={scheme:'local',id:root.publicKey};
 const wrongBinding=await provider.bindSession({principal:{scheme:'local',id:other.publicKey},scope:scopeOf()});
 expect(wrongBinding).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 const delegating:IdentityProof={kind:'identity',principal:localPrincipal,sessionKey:session.publicKey,scope:scopeOf(),delegation:{algorithm:'Ed25519',key:other.publicKey,value:''}};
 const forged:IdentityProof={...delegating,delegation:{algorithm:'Ed25519',key:other.publicKey,value:await signEd25519(other,identityBytes(delegating,codec))}};
 expect(await verifier.verify(forged,identityBytes(forged,codec))).toBe(true);
 const grant=await grantOf({principal:localPrincipal});
 const proposal=await proposalOf({principal:localPrincipal});
 expect(await refusal(grant,proposal,{identity:forged})).toBe('SIGNATURE');
 const honest=await provider.bindSession({principal:localPrincipal,scope:scopeOf()});
 if(!honest.ok)throw new Error(honest.error.message);
 const accepted=await authorize(grant,proposal,contextOf({identity:honest.value}));
 expect(accepted.ok).toBe(true);
});

test('a signature that does not cover the proposal is refused',async()=>{
 const grant=await grantOf();
 const proposal=await proposalOf();
 const oneBit=`${proposal.proof.signature[0]==='0'?'1':'0'}${proposal.proof.signature.slice(1)}`;
 expect(await refusal(grant,{...proposal,proof:{...proposal.proof,signature:oneBit}})).toBe('SIGNATURE');
 expect(await refusal(grant,{...proposal,proof:{...proposal.proof,signature:proposal.proof.signature.slice(0,126)}})).toBe('SIGNATURE');
 // The envelope is what the signature covers: changing the intent after signing invalidates it.
 const altered:Proposal={...proposal,intent:{type:'demolish',cells:[here(1,1)]}};
 expect(await refusal(grant,altered)).toBe('SIGNATURE');
 expect(await refusal(grant,{...proposal,observedHead:{hash:'cc'.repeat(32),bytes:1}})).toBe('SIGNATURE');
 expect(await refusal(grant,{...proposal,costLimit:999})).toBe('SIGNATURE');
});

test('a grant that is expired, revoked or out of region is refused',async()=>{
 const proposal=await proposalOf();
 expect(await refusal(await grantOf({notAfter:'2026-09-29T11:00:00Z'}),proposal)).toBe('PERMISSION');
 expect(await refusal(await grantOf({notBefore:'2026-09-29T13:00:00Z'}),proposal)).toBe('PERMISSION');
 expect(await refusal(await grantOf(),proposal,{revokedGrants:['concessao-1']})).toBe('PERMISSION');
 expect(await refusal(await grantOf({epoch:2}),proposal)).toBe('PERMISSION');
 expect(await refusal(await grantOf({principal:{scheme:'nostr',id:'npub1beto'}}),proposal)).toBe('PERMISSION');
 const inside=await proposalOf({intent:{type:'build',tool:'park',cells:[here(1,1),here(2,2)]}});
 expect((await authorize(await grantOf(),inside,contextOf())).ok).toBe(true);
 const outside=await proposalOf({intent:{type:'build',tool:'park',cells:[{x:1,y:1}]}});
 expect(await refusal(await grantOf(),outside)).toBe('PERMISSION');
 expect((await authorize(await grantOf({regions:undefined}),outside,contextOf())).ok).toBe(true);
});

test('a delegated host cannot widen the grant that issued it',async()=>{
 const outer=await grantOf({id:'concessao-raiz',actions:['build'],spendLimit:100});
 const proposal=await proposalOf({costLimit:40});
 const wide=await grantOf({id:'concessao-anfitriao',delegatedBy:'concessao-raiz',actions:['build','demolish'],spendLimit:100});
 expect(await refusal(wide,proposal,{chain:[outer]})).toBe('PERMISSION');
 const greedy=await grantOf({id:'concessao-anfitriao',delegatedBy:'concessao-raiz',actions:['build'],spendLimit:500});
 expect(await refusal(greedy,proposal,{chain:[outer]})).toBe('PERMISSION');
 const broken=await grantOf({id:'concessao-anfitriao',delegatedBy:'outra-concessao',actions:['build'],spendLimit:50});
 expect(await refusal(broken,proposal,{chain:[outer]})).toBe('PERMISSION');
 const derived=await grantOf({id:'concessao-anfitriao',delegatedBy:'concessao-raiz',actions:['build'],spendLimit:50});
 expect((await authorize(derived,proposal,contextOf({chain:[outer]}))).ok).toBe(true);
 const orphan=await grantOf({delegatedBy:'concessao-raiz'});
 expect(await refusal(orphan,proposal)).toBe('PERMISSION');
});

test('a namespace or entity outside the grant is refused',async()=>{
 const grant=await grantOf();
 const allowed=await proposalOf({intent:{type:'component',key:'cidade.transito',entity:'ent-1',value:{closed:true}}});
 expect((await authorize(grant,allowed,contextOf())).ok).toBe(true);
 const forbidden=await proposalOf({intent:{type:'component',key:'clima.tempo',entity:'ent-1',value:{rain:1}}});
 expect(await refusal(grant,forbidden)).toBe('PERMISSION');
 const entity=await proposalOf({intent:{type:'component',key:'cidade.transito',entity:'ent-2',value:{closed:false}}});
 expect(await refusal(await grantOf({entities:['ent-1']}),entity)).toBe('PERMISSION');
 const actionless=await proposalOf({intent:{type:'component',key:'cidade.transito',entity:'ent-1',value:{}}});
 expect(await refusal(await grantOf({actions:['build']}),actionless)).toBe('PERMISSION');
});

test('the shared intent parser covers every action the current city UI can send',()=>{
 expect(intentFrom({type:'build',tool:'avenue',cells:[here(1,1)]})).toMatchObject({ok:true,value:{type:'build',tool:'avenue'}});
 expect(intentFrom({type:'build',tool:'highway',cells:[here(2,2)]})).toMatchObject({ok:true,value:{type:'build',tool:'highway'}});
 expect(intentFrom({type:'policy',tax:12,services:115,borrow:10_000})).toEqual({ok:true,value:{type:'policy',tax:12,services:115,borrow:10_000}});
 expect(intentFrom({type:'policy'})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(intentFrom({type:'build',tool:'monorail',cells:[here(1,1)]})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
});

test('a proposal replayed in another branch or epoch is refused',async()=>{
 const grant=await grantOf();
 const first=await proposalOf();
 const mark={id:first.id,epoch:1,worldId:'victoria',branchId:'main',digest:(await hasher.ref(proposalBytes(first,codec))).hash};
 expect(await authorize(grant,first,contextOf({marks:[mark]}))).toMatchObject({ok:true,value:{duplicate:true}});
 expect(await refusal(grant,first,contextOf({marks:[{...mark,branchId:'experimento'}]}))).toBe('CONFLICT');
 expect(await refusal(grant,first,contextOf({marks:[{...mark,epoch:0}]}))).toBe('CONFLICT');
 expect(await refusal(grant,first,contextOf({marks:[{...mark,worldId:'outro'}]}))).toBe('CONFLICT');
 expect(await refusal(grant,first,contextOf({marks:[{...mark,digest:'bb'.repeat(32)}]}))).toBe('CONFLICT');
 expect(await refusal(grant,await proposalOf(),{epoch:2})).toBe('PERMISSION');
 expect(await refusal(grant,await proposalOf(),{head:{...head,commit:{hash:'cc'.repeat(32),bytes:1}}})).toBe('CONFLICT');
 expect(await refusal(grant,await proposalOf({preconditions:{revision:3}}))).toBe('CONFLICT');
});

test('an external principal maps to the deterministic actor id the core orders by',async()=>{
 const id=await actorId(ANA,hasher,codec);
 expect(id).toMatch(/^p_[0-9a-f]{64}$/);
 expect(id.length).toBe(66);
 expect(await actorId(ANA,hasher,codec)).toBe(id);
 expect(await actorId({scheme:'matrix',id:ANA.id},hasher,codec)).not.toBe(id);
 const state=createGame('victoria',1,blank('9:9'));
 const applied=applyCommand(state,{version:1,worldId:'victoria',actorId:id,sequence:1,expectedRevision:0,action:{type:'tick'}},[]);
 expect(applied.status).toBe('applied');
 expect(applied.state.actors[id]).toBe(1);
});

test('negotiation refuses incompatible rules and fences unknown critical namespaces',async()=>{
 const compatible=await negotiate(capabilities(),capabilities({actions:['build']}));
 if(!compatible.ok)throw new Error(compatible.error.message);
 expect(compatible.value.write).toBe(true);
 expect(compatible.value.actions).toEqual(['build']);
 expect(compatible.value.critical).toEqual(['cidade.transito']);
 expect(compatible.value.unknownCritical).toEqual([]);
 expect(roleFor(compatible.value)).toBe('collaborator');
 // The peer declares a critical namespace this client does not implement: the format stays readable, writing stops.
 const extended=await negotiate(capabilities(),capabilities({namespaces:[...capabilities().namespaces,{key:'clima.tempo',critical:true}],limits:{...NETWORK_LIMITS,maxProposalQueue:64}}));
 if(!extended.ok)throw new Error(extended.error.message);
 expect(extended.value.write).toBe(false);
 expect(extended.value.unknownCritical).toEqual(['clima.tempo']);
 expect(extended.value.limits.maxProposalQueue).toBe(64);
 expect(extended.value.limits.maxDurableBytes).toBe(NETWORK_LIMITS.maxDurableBytes);
 const roleForUnknownCritical=roleFor(extended.value);
 expect(roleForUnknownCritical).toBe('spectator');
 // A critical namespace of ours that the peer does not implement is fenced the same way.
 const oneSided=await negotiate(capabilities(),capabilities({namespaces:[]}));
 if(!oneSided.ok)throw new Error(oneSided.error.message);
 expect(oneSided.value.unsupportedCritical).toEqual(['cidade.transito']);
 expect(oneSided.value.write).toBe(false);
 expect(roleFor(oneSided.value)).toBe('spectator');
 expect(await negotiate(capabilities(),capabilities({rules:{family:'city',version:RULES_VERSION+1}}))).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 expect(await negotiate(capabilities(),capabilities({rules:{family:'explorer',version:1}}))).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 expect(await negotiate(capabilities(),capabilities({wireVersion:2}))).toMatchObject({ok:false,error:{code:'WIRE_VERSION_UNSUPPORTED'}});
 expect(await negotiate(capabilities(),capabilities({worldProtocol:3}))).toMatchObject({ok:false,error:{code:'WORLD_PROTOCOL_UNSUPPORTED'}});
});

test('an approved cost stays inside the proposal and the grant ceilings',async()=>{
 const grant=await grantOf();
 const two=await proposalOf({intent:{type:'build',tool:'park',cells:[here(1,1),here(2,2)]},costLimit:100});
 const approved=await authorize(grant,two,contextOf());
 if(!approved.ok)throw new Error(approved.error.message);
 expect(approved.value.approvedCost).toBe(60);
 expect(approved.value.action).toBe('build');
 expect(await refusal(grant,await proposalOf({costLimit:10}))).toBe('PERMISSION');
 expect(await refusal(await grantOf({spendLimit:50}),await proposalOf({costLimit:100}))).toBe('PERMISSION');
 const repeated=await proposalOf({intent:{type:'build',tool:'park',cells:[here(1,1),here(1,1)]},costLimit:100});
 const deduped=await authorize(grant,repeated,contextOf());
 expect(deduped.ok&&deduped.value.approvedCost).toBe(30);
});

test('a refused or repeated proposal never consumes the accepted sequence of the core',async()=>{
 const grant=await grantOf();
 const state=createGame('victoria',1,blank('9:9'));
 const first=await proposalOf({id:'proposta-1'});
 const accepted=await authorize(grant,first,contextOf());
 if(!accepted.ok)throw new Error(accepted.error.message);
 const actor=accepted.value.actorId;
 const firstCommand=commandFor(accepted.value,state);
 if(!firstCommand.ok)throw new Error(firstCommand.error.message);
 const applied=applyCommand(state,firstCommand.value,[]);
 expect(applied.status).toBe('applied');
 if(applied.status!=='applied')return;
 expect(applied.state.actors[actor]).toBe(1);
 // A refused proposal produces no command, so the accepted sequence stays where it was.
 const forbidden=await proposalOf({id:'proposta-2',preconditions:{revision:1},intent:{type:'component',key:'clima.tempo',entity:'ent-1',value:{rain:1}}});
 expect(await refusal(grant,forbidden,{revision:1})).toBe('PERMISSION');
 // A repeated delivery answers with the previous result and does not reach the core again.
 const repeated=await authorize(grant,first,contextOf({marks:[{id:first.id,epoch:1,worldId:'victoria',branchId:'main',digest:accepted.value.digest}]}));
 if(!repeated.ok)throw new Error(repeated.error.message);
 expect(repeated.value.duplicate).toBe(true);
 expect(commandFor(repeated.value,applied.state)).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 // The next accepted proposal takes the following sequence: no gap was opened by the two attempts above.
 const next=await proposalOf({id:'proposta-3',preconditions:{revision:1},intent:{type:'build',tool:'park',cells:[here(2,2)]}});
 const second=await authorize(grant,next,contextOf({revision:1}));
 if(!second.ok)throw new Error(second.error.message);
 const secondCommand=commandFor(second.value,applied.state);
 if(!secondCommand.ok)throw new Error(secondCommand.error.message);
 expect(secondCommand.value.sequence).toBe(2);
 const grown=applyCommand(applied.state,secondCommand.value,[]);
 expect(grown.status).toBe('applied');
 if(grown.status!=='applied')return;
 expect(grown.state.actors[actor]).toBe(2);
});

test('a grant travels signed by the issuer session key',async()=>{
 const grant=await grantOf();
 const issuer={codec,verifier};
 expect(await verifyGrant(grant,identity,issuer)).toEqual({ok:true,value:grant});
 const oneBit=`${grant.proof.signature[0]==='0'?'1':'0'}${grant.proof.signature.slice(1)}`;
 expect(await verifyGrant({...grant,proof:{...grant.proof,signature:oneBit}},identity,issuer)).toMatchObject({ok:false,error:{code:'SIGNATURE'}});
 expect(await verifyGrant({...grant,spendLimit:9000},identity,issuer)).toMatchObject({ok:false,error:{code:'SIGNATURE'}});
 expect(await verifyGrant(grant,{...identity,sessionKey:other.publicKey},issuer)).toMatchObject({ok:false,error:{code:'SIGNATURE'}});
});

test('an identity bound to another session or past its window cannot authorize',async()=>{
 const grant=await grantOf();
 const proposal=await proposalOf();
 const elsewhere=await provider.bindSession({principal:ANA,scope:scopeOf({sessionId:'sessao-2'})});
 if(!elsewhere.ok)throw new Error(elsewhere.error.message);
 expect(await refusal(grant,proposal,{identity:elsewhere.value})).toBe('SIGNATURE');
 const late=await provider.bindSession({principal:ANA,scope:scopeOf({notAfter:'2026-09-29T11:30:00Z'})});
 if(!late.ok)throw new Error(late.error.message);
 expect(await refusal(grant,proposal,{identity:late.value})).toBe('SIGNATURE');
 const otherPrincipal=await provider.bindSession({principal:{scheme:'nostr',id:'npub1beto'},scope:scopeOf()});
 if(!otherPrincipal.ok)throw new Error(otherPrincipal.error.message);
 expect(await refusal(grant,proposal,{identity:otherPrincipal.value})).toBe('SIGNATURE');
});

test('the control schemas are closed and round-trip what they accept',async()=>{
 const grant=await grantOf();
 expect(controlFrom(grant as unknown as JsonValue)).toEqual({ok:true,value:{kind:'grant',grant}});
 expect(controlFrom({...grant,future:true} as unknown as JsonValue)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(controlFrom({...grant,spendLimit:-1} as unknown as JsonValue)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 const proposal=await proposalOf();
 expect(controlFrom(proposal as unknown as JsonValue)).toEqual({ok:true,value:{kind:'proposal',proposal}});
 expect(controlFrom({...proposal,future:true} as unknown as JsonValue)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(controlFrom({...proposal,principal:{scheme:'NOSTR',id:'ana'}} as unknown as JsonValue)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(controlFrom({...proposal,wireVersion:2} as unknown as JsonValue)).toMatchObject({ok:false,error:{code:'WIRE_VERSION_UNSUPPORTED'}});
 expect(controlFrom({kind:'desconhecido'})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(controlFrom(identity as unknown as JsonValue)).toEqual({ok:true,value:{kind:'identity',identity}});
 expect(controlFrom({...identity,future:1} as unknown as JsonValue)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(controlFrom(capabilities() as unknown as JsonValue)).toEqual({ok:true,value:{kind:'capabilities',capabilities:capabilities()}});
 expect(controlFrom({...capabilities(),future:1} as unknown as JsonValue)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 const agreement=await negotiate(capabilities(),capabilities({actions:['build']}));
 if(!agreement.ok)throw new Error(agreement.error.message);
 expect(controlFrom(agreement.value as unknown as JsonValue)).toEqual({ok:true,value:{kind:'agreement',agreement:agreement.value}});
 expect(controlFrom({...agreement.value,future:1} as unknown as JsonValue)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
});
