import type {SessionListener,SessionTransport} from '../../session/multiplayer-ports';
import type {WireMessage} from '../../world/wire';

// A transport that moves framed messages between the peers of one process, so a session can be exercised end to end
// without a network stack (docs/superpowers/specs/2026-09-29-federated-world-design.md §7.3, §9.1). The transport
// decides nothing: it moves what it is given, it refuses what it cannot deliver, and it never interprets a body.
//
// Nothing is delivered until the caller says so. The queue drains in the order the messages were sent, which is what
// makes a reordered, duplicated or dropped delivery a decision of the caller instead of a property of a scheduler:
// `batch` takes the frames without handing them over, `dispatch` hands one over, and `deliver` does the ordinary thing.
export type MemoryDelivery={from:string;to:string;message:WireMessage};
export type MemoryNetwork={
 connect(peer:string):SessionTransport;
 disconnect(peer:string):void;
 connected():readonly string[];
 queued():number;
 // Removes and returns what was queued, in send order, without reaching any listener.
 batch(limit?:number):MemoryDelivery[];
 // Hands one frame to the peer it is addressed to; `false` when that peer is no longer connected.
 dispatch(delivery:MemoryDelivery):boolean;
 // Hands the queued frames over in order; returns how many reached a peer.
 deliver(limit?:number):number;
};
export function createMemoryNetwork():MemoryNetwork{
 const listeners=new Map<string,Set<SessionListener>>();
 const queue:MemoryDelivery[]=[];
 const dispatch=(delivery:MemoryDelivery):boolean=>{
  const subscribers=listeners.get(delivery.to);
  if(!subscribers)return false;
  for(const listener of [...subscribers])listener(delivery.from,delivery.message);
  return true;
 };
 return {
  connect(peer){
   const subscribers=new Set<SessionListener>();
   listeners.set(peer,subscribers);
   return {
    async send(to,message){
     // A peer that left is a peer a message cannot reach: the caller learns it here instead of at a timeout.
     if(!listeners.has(to))throw new Error(`Par desconectado: ${to}`);
     queue.push({from:peer,to,message});
    },
    subscribe(listener){
     subscribers.add(listener);
     return()=>{subscribers.delete(listener);};
    },
   };
  },
  disconnect(peer){listeners.delete(peer);},
  connected:()=>[...listeners.keys()].sort(),
  queued:()=>queue.length,
  batch:(limit=Infinity)=>queue.splice(0,limit),
  dispatch,
  deliver(limit=Infinity){
   let delivered=0;
   for(const delivery of queue.splice(0,limit))if(dispatch(delivery))delivered+=1;
   return delivered;
  },
 };
}
