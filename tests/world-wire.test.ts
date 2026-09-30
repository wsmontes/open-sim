import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {decodeMessage,encodeMessage,NETWORK_LIMITS,narrowerLimits,replayOf} from '../src/world/wire';
import type {Limits,WireEnvelope,WireMessage} from '../src/world/wire';
import type {JsonValue} from '../src/world/model';

const codec=createJcsCodec();
const text=(value:string)=>new TextEncoder().encode(value);
const envelope=(overrides:Partial<WireEnvelope>={}):WireEnvelope=>({worldProtocol:2,wireVersion:1,kind:'message',class:'control',worldId:'victoria',branchId:'main',sessionId:'sessao-1',epoch:1,id:'msg-1',...overrides});
const message=(body:JsonValue,overrides:Partial<WireEnvelope>={}):WireMessage=>({envelope:envelope(overrides),body});
const raw=(envelopeValue:JsonValue,body:JsonValue={kind:'proposal'})=>text(JSON.stringify({envelope:envelopeValue,body}));

test('a message keeps its envelope and body across the wire',()=>{
 const original=message({kind:'proposal',id:'proposta-1',cells:[{x:1,y:2}]});
 expect(decodeMessage(encodeMessage(original,codec))).toEqual({ok:true,value:original});
});

test('the envelope is closed, declared and shaped before anything else',()=>{
 expect(decodeMessage(raw({...envelope(),future:true}))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 const missing=(({epoch,...rest})=>rest)(envelope());
 expect(decodeMessage(raw(missing))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(decodeMessage(raw({...envelope(),kind:'bundle'}))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(decodeMessage(raw({...envelope(),class:'stream'}))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(decodeMessage(raw({...envelope(),epoch:-1}))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(decodeMessage(raw({...envelope(),id:''}))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(decodeMessage(raw(envelope(),{notKind:true}))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(decodeMessage(raw(envelope(),{kind:''}))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(decodeMessage(text('{"envelope":{"worldProtocol":2,"wireVersion":1,"kind":"message","class":"control","worldId":"a","branchId":"b","sessionId":"c","epoch":1,"id":"d","__proto__":{"x":1}},"body":{"kind":"n"}}'))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
});

test('an unknown world protocol or wire version is refused',()=>{
 expect(decodeMessage(raw({...envelope(),worldProtocol:3}))).toMatchObject({ok:false,error:{code:'WORLD_PROTOCOL_UNSUPPORTED'}});
 expect(decodeMessage(raw({...envelope(),wireVersion:2}))).toMatchObject({ok:false,error:{code:'WIRE_VERSION_UNSUPPORTED'}});
});

test('each class of traffic has its own byte ceiling, checked before parsing',()=>{
 const heavy={kind:'grant',blob:'x'.repeat(70*1024)};
 expect(decodeMessage(encodeMessage(message(heavy),codec))).toMatchObject({ok:false,error:{code:'LIMIT'}});
 expect(decodeMessage(encodeMessage(message(heavy,{class:'durable'}),codec))).toMatchObject({ok:false,error:{code:'LIMIT'}});
 const segment={kind:'segment',blob:'x'.repeat(17*1024)};
 expect(decodeMessage(encodeMessage(message(segment,{class:'object'}),codec))).toMatchObject({ok:false,error:{code:'LIMIT'}});
 expect(decodeMessage(encodeMessage(message({kind:'segment',blob:'x'.repeat(8*1024)},{class:'object'}),codec))).toMatchObject({ok:true});
});

test('a message that is not strict JSON, or repeats a key, is refused',()=>{
 expect(decodeMessage(text('{"envelope":{"worldProtocol":2},"envelope":{"worldProtocol":2}}'))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(decodeMessage(text('{"envelope":{},"body":{}} extra'))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(decodeMessage(new Uint8Array([0x7b,0xff,0x7d]))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
});

test('a repeated id is a duplicate, and the same id in another epoch or branch is a replay',()=>{
 const seen=[envelope({id:'a'}),envelope({id:'b',epoch:2})];
 expect(replayOf(seen,envelope({id:'c'}))).toBe('new');
 expect(replayOf(seen,envelope({id:'a'}))).toBe('duplicate');
 expect(replayOf(seen,envelope({id:'b'}))).toBe('replay');
 expect(replayOf(seen,envelope({id:'b',epoch:2}))).toBe('duplicate');
 expect(replayOf(seen,envelope({id:'a',branchId:'experimento'}))).toBe('replay');
 expect(replayOf(seen,envelope({id:'a',sessionId:'outra-sessao'}))).toBe('replay');
});

test('negotiated limits take the narrower value of both sides',()=>{
 const tight:Limits={...NETWORK_LIMITS,participants:2,maxControlBytes:1024,maxProposalQueue:8};
 const narrow=narrowerLimits(NETWORK_LIMITS,tight);
 expect(narrow.participants).toBe(2);
 expect(narrow.maxControlBytes).toBe(1024);
 expect(narrow.maxProposalQueue).toBe(8);
 expect(narrow.maxDurableBytes).toBe(NETWORK_LIMITS.maxDurableBytes);
 expect(narrowerLimits(tight,NETWORK_LIMITS)).toEqual(narrow);
});
