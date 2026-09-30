import type {RtcChannel,RtcDescription,RtcEvent,RtcFactory,RtcPeer} from '../../src/adapters/network/webrtc';

// The platform of a session link, in process (tests of the WebRTC adapter and of the adapters that signal for it):
// two fake peer connections paired by one factory, with the descriptions travelling through whatever `Signaling` port
// the caller configured. The adapter under test runs its real code — channels, descriptions, ICE, backpressure — and
// the test needs no network. Two in-process peers are not evidence about NAT, so nothing using this claims that.

export type WiredChannel = RtcChannel & {sent: Uint8Array[]; deliver(bytes: Uint8Array): void; open(): void; attach(other: WiredChannel): void};
export function wiredChannel(label: string): WiredChannel {
 const listeners = new Map<string, Set<(event: RtcEvent) => void>>();
 const sent: Uint8Array[] = [];
 let twin: WiredChannel | null = null, state = 'connecting';
 const emit = (type: string, event: RtcEvent = {}) => {for (const listener of [...(listeners.get(type) ?? [])]) listener({type, ...event});};
 return {
  label, sent, binaryType: 'arraybuffer', bufferedAmount: 0, bufferedAmountLowThreshold: 0,
  get readyState() {return state;},
  send(data) {const frame = data.slice(); sent.push(frame); twin?.deliver(frame);},
  close() {state = 'closed'; emit('close');},
  addEventListener(type, listener) {const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set);},
  removeEventListener(type, listener) {listeners.get(type)?.delete(listener);},
  deliver(bytes) {emit('message', {data: bytes});},
  open() {state = 'open'; emit('open');},
  attach(other) {twin = other;},
 };
}
export type WiredPeer = RtcPeer & {ready(): boolean; channels(): Map<string, WiredChannel>; adopt(channel: WiredChannel): void};
export function wiredPeer(poke: () => void): WiredPeer {
 const channels = new Map<string, WiredChannel>(), listeners = new Map<string, Set<(event: RtcEvent) => void>>();
 let local: RtcDescription | null = null, remote: RtcDescription | null = null, state = 'new';
 const emit = (type: string, event: RtcEvent = {}) => {for (const listener of [...(listeners.get(type) ?? [])]) listener({type, ...event});};
 return {
  createDataChannel(label) {const channel = wiredChannel(label); channels.set(label, channel); return channel;},
  async createOffer() {return {type: 'offer', sdp: 'v=0\r\no=fake-offer 1 1 IN IP4 127.0.0.1\r\n'};},
  async createAnswer() {return {type: 'answer', sdp: 'v=0\r\no=fake-answer 1 1 IN IP4 127.0.0.1\r\n'};},
  async setLocalDescription(description) {local = description; state = 'connecting'; emit('icecandidate', {candidate: {candidate: 'candidate:1 1 udp 2122260223 127.0.0.1 4000 typ host', sdpMid: '0', sdpMLineIndex: 0}}); poke();},
  async setRemoteDescription(description) {remote = description; poke();},
  async addIceCandidate() {},
  get localDescription() {return local;},
  get remoteDescription() {return remote;},
  get connectionState() {return state;},
  close() {state = 'closed'; for (const channel of channels.values()) channel.close(); emit('connectionstatechange');},
  addEventListener(type, listener) {const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set);},
  removeEventListener(type, listener) {listeners.get(type)?.delete(listener);},
  ready: () => local !== null && remote !== null,
  channels: () => channels,
  adopt(channel) {channels.set(channel.label, channel); emit('datachannel', {channel});},
 };
}
export function wiredPair(): {factory: RtcFactory; peers: WiredPeer[]} {
 const peers: WiredPeer[] = [];
 // The link exists once both sides hold a description: the offerer's channels are adopted by the answerer, which is
 // what a real `datachannel` event does.
 const pair = () => {
  const [first, second] = peers;
  if (!first || !second || !first.ready() || !second.ready()) return;
  for (const [label, channel] of first.channels()) {
   if (second.channels().has(label)) continue;
   const twin = wiredChannel(label);
   second.adopt(twin);
   channel.attach(twin);
   twin.attach(channel);
   channel.open();
   twin.open();
  }
 };
 return {factory: () => {const peer = wiredPeer(pair); peers.push(peer); return peer;}, peers};
}
