import {createHmac} from 'node:crypto';
import type {MatrixFetch, MatrixResponse} from '../../src/adapters/matrix/identity';
import type {JsonValue} from '../../src/world/model';

// An in-process Matrix homeserver, small enough to read and complete enough to be the real thing's shape: the client
// -server API subset this project's adapter uses, the shared-secret registration Synapse exposes, room membership,
// paginated `/messages` and `/sync` with their own tokens. Nothing here touches the network, which is what lets the
// matrix adapter's unit tests exercise the same code path the real homeserver is exercised with.
//
// It is deliberately not permissive: a request without a token is 401, a read by a non-member is 403, an unknown
// transaction id is not idempotent by accident, and events the adapter should ignore (another room, another type,
// another sender) can be injected exactly as a server would deliver them — a server is somebody else's machine and
// the tests need to be able to lie like one.

export type FakeEvent = {event_id: string; type: string; sender: string; room_id: string; origin_server_ts: number; content: JsonValue; state_key?: string};

export type FakeHomeserver = {
 serverName: string;
 secret: string;
 fetch: MatrixFetch;
 users(): readonly string[];
 tokenOf(userId: string): string | undefined;
 rooms(): readonly string[];
 events(roomId: string): readonly FakeEvent[];
 send(roomId: string, sender: string, type: string, content: JsonValue): string;
 inject(roomId: string, event: Partial<FakeEvent> & {type: string; content: JsonValue}): string;
 requests(): number;
 fail(matcher: (path: string, method: string) => boolean, status: number, errcode: string, error: string): void;
 clearFailures(): void;
};

const SERVER = 'matrix.test';
export function fakeHomeserver(options: {serverName?: string; secret?: string} = {}): FakeHomeserver {
 const serverName = options.serverName ?? SERVER, secret = options.secret ?? 'lab-registration-secret-value';
 type User = {userId: string; token: string; password: string};
 type Room = {roomId: string; creator: string; joinRule: string; historyVisibility: string; state: Map<string, JsonValue>; members: Map<string, string>; power: Record<string, number>; log: {event: FakeEvent; seq: number}[]};
 const users = new Map<string, User>(), rooms = new Map<string, Room>(), txns = new Map<string, string>();
 let nonce = 0, nextUser = 0, nextRoom = 0, nextEvent = 0, seq = 0, requests = 0;
 const failures: {matcher: (path: string, method: string) => boolean; status: number; errcode: string; error: string}[] = [];
 const roomIdOf = (index: number) => `!room${index}:${serverName}`;
 const eventOf = (room: Room, sender: string, type: string, content: JsonValue, stateKey?: string): FakeEvent => {
  const event: FakeEvent = {event_id: `$${++nextEvent}:${serverName}`, type, sender, room_id: room.roomId, origin_server_ts: 1_700_000_000_000 + nextEvent, content};
  if (stateKey !== undefined) event.state_key = stateKey;
  room.log.push({event, seq: ++seq});
  if (stateKey !== undefined) room.state.set(`${type}\u0000${stateKey}`, content);
  return event;
 };
 const membership = (room: Room, userId: string, membershipValue: string) => eventOf(room, userId, 'm.room.member', {membership: membershipValue}, userId);
 const response = (status: number, value: unknown): MatrixResponse => ({status, text: async () => JSON.stringify(value)});
 const errorOf = (status: number, errcode: string, error: string) => response(status, {errcode, error});
 const userIdFromToken = (token: string | null): User | null => {
  if (!token) return null;
  for (const user of users.values()) if (user.token === token) return user;
  return null;
 };
 const memberOf = (room: Room, userId: string) => room.members.get(userId) === 'join';

 const handle = async (url: string, init: {method: string; headers: Record<string, string>; body?: string}): Promise<MatrixResponse> => {
  requests += 1;
  const parsed = new URL(url);
  const path = parsed.pathname;
  for (const failure of failures) if (failure.matcher(path, init.method)) return errorOf(failure.status, failure.errcode, failure.error);
  const contentType = init.headers['Content-Type'] ?? init.headers['content-type'];
  const payload = init.body ? JSON.parse(init.body) as Record<string, JsonValue> : {};
  if (init.body && contentType !== 'application/json') return errorOf(400, 'M_NOT_JSON', 'Content-Type precisa ser application/json');
  const authorization = init.headers['Authorization'] ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
  const user = userIdFromToken(token);

  // --- registration and authentication ------------------------------------------------------------------------
  if (path === '/_synapse/admin/v1/register') {
   if (init.method === 'GET') return response(200, {nonce: `nonce-${++nonce}`});
   const {nonce: used, username, password, admin, mac} = payload as Record<string, string>;
   const expected = createHmac('sha1', secret).update([String(used), String(username), String(password), admin ? 'admin' : 'notadmin'].join('\u0000')).digest('hex');
   if (mac !== expected) return errorOf(403, 'M_FORBIDDEN', 'Invalid MAC');
   const userId = `@${String(username)}:${serverName}`;
   if (users.has(userId)) return errorOf(400, 'M_USER_IN_USE', `User ${userId} already exists`);
   const created = {userId, token: `token-${++nextUser}-${Math.random().toString(36).slice(2, 10)}`, password: String(password)};
   users.set(userId, created);
   return response(200, {user_id: userId, access_token: created.token, device_id: `DEVICE${nextUser}`});
  }
  if (path === '/_matrix/client/v3/login') {
   const identifier = (payload['identifier'] ?? {}) as Record<string, JsonValue>;
   const userId = `@${String(identifier['user'])}:${serverName}`;
   const found = users.get(userId);
   if (!found || found.password !== String(payload['password'] ?? '')) return errorOf(403, 'M_FORBIDDEN', 'Invalid password');
   return response(200, {user_id: userId, access_token: found.token, device_id: 'DEVICE-LOGIN'});
  }
  if (path === '/_matrix/client/v3/account/whoami') {
   if (!user) return errorOf(401, 'M_UNKNOWN_TOKEN', 'Invalid access token');
   return response(200, {user_id: user.userId, device_id: 'DEVICE1'});
  }

  // --- rooms --------------------------------------------------------------------------------------------------
  if (path === '/_matrix/client/v3/createRoom') {
   if (!user) return errorOf(401, 'M_UNKNOWN_TOKEN', 'Invalid access token');
   const preset = String(payload['preset'] ?? 'private_chat');
   const room: Room = {
    roomId: roomIdOf(++nextRoom), creator: user.userId,
    joinRule: preset === 'public_chat' ? 'public' : 'invite',
    historyVisibility: 'shared',
    state: new Map(), members: new Map(), power: {[user.userId]: 100}, log: [],
   };
   rooms.set(room.roomId, room);
   eventOf(room, user.userId, 'm.room.create', {creator: user.userId, room_version: '11'}, '');
   eventOf(room, user.userId, 'm.room.join_rules', {join_rule: room.joinRule}, '');
   eventOf(room, user.userId, 'm.room.history_visibility', {history_visibility: room.historyVisibility}, '');
   eventOf(room, user.userId, 'm.room.power_levels', {users: {...room.power}, users_default: 0, events_default: 0, state_default: 50}, '');
   if (typeof payload['name'] === 'string') eventOf(room, user.userId, 'm.room.name', {name: payload['name']}, '');
   membership(room, user.userId, 'join');
   room.members.set(user.userId, 'join');
   for (const invited of (payload['invite'] as string[] | undefined) ?? []) {
    membership(room, user.userId, 'invite');
    room.members.set(invited, 'invite');
   }
   return response(200, {room_id: room.roomId});
  }
  const roomMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/(.+)$/.exec(path);
  if (roomMatch) {
   const roomId = decodeURIComponent(roomMatch[1]!), rest = roomMatch[2]!;
   const room = rooms.get(roomId);
   if (!user) return errorOf(401, 'M_UNKNOWN_TOKEN', 'Invalid access token');
   if (!room) return errorOf(404, 'M_NOT_FOUND', 'Unknown room');
   if (rest === 'invite') {
    const target = String(payload['user_id'] ?? '');
    if (!users.has(target)) return errorOf(404, 'M_NOT_FOUND', 'Unknown user');
    membership(room, user.userId, 'invite');
    room.members.set(target, 'invite');
    return response(200, {});
   }
   if (rest === 'messages') {
    if (!memberOf(room, user.userId)) return errorOf(403, 'M_FORBIDDEN', 'You are not a member of this room');
    const limit = Number(parsed.searchParams.get('limit') ?? '10');
    const from = parsed.searchParams.get('from');
    const dir = parsed.searchParams.get('dir') ?? 'b';
    if (dir !== 'b') return errorOf(400, 'M_INVALID_PARAM', 'Only dir=b is supported here');
    const ordered = [...room.log].sort((left, right) => right.seq - left.seq);
    const start = from ? Number(from.replace(/^t/, '')) : 0;
    if (!Number.isFinite(start) || start < 0) return errorOf(400, 'M_INVALID_PARAM', 'Invalid from token');
    const page = ordered.slice(start, start + limit);
    const end = start + page.length < ordered.length ? `t${start + page.length}` : null;
    return response(200, {start: `t${start}`, end, chunk: page.map(entry => entry.event)});
   }
   if (rest === 'send') {
    return errorOf(404, 'M_NOT_FOUND', 'Malformed send path');
   }
   const sendMatch = /^send\/([^/]+)\/([^/]+)$/.exec(rest);
   if (sendMatch && init.method === 'PUT') {
    if (!memberOf(room, user.userId)) return errorOf(403, 'M_FORBIDDEN', 'You are not a member of this room');
    const eventType = decodeURIComponent(sendMatch[1]!), txnId = decodeURIComponent(sendMatch[2]!);
    const key = `${roomId}\u0000${user.userId}\u0000${txnId}`;
    const known = txns.get(key);
    if (known) return response(200, {event_id: known});
    // A client may write an encrypted event of its own; every other reserved type is the homeserver's business.
    if (eventType.startsWith('m.') && eventType !== 'm.room.encrypted') return errorOf(400, 'M_BAD_JSON', `Event type ${eventType} is reserved`);
    const event = eventOf(room, user.userId, eventType, payload);
    txns.set(key, event.event_id);
    return response(200, {event_id: event.event_id});
   }
   const singleMatch = /^event\/([^/]+)$/.exec(rest);
   if (singleMatch) {
    if (!memberOf(room, user.userId)) return errorOf(403, 'M_FORBIDDEN', 'You are not a member of this room');
    const wanted = decodeURIComponent(singleMatch[1]!);
    const found = room.log.find(entry => entry.event.event_id === wanted);
    if (!found) return errorOf(404, 'M_NOT_FOUND', 'Event not found');
    return response(200, found.event);
   }
   const stateMatch = /^state\/([^/]+)(?:\/([^/]*))?$/.exec(rest);
   if (stateMatch) {
    if (!memberOf(room, user.userId)) return errorOf(403, 'M_FORBIDDEN', 'You are not a member of this room');
    const eventType = decodeURIComponent(stateMatch[1]!), stateKey = decodeURIComponent(stateMatch[2] ?? '');
    const found = room.state.get(`${eventType}\u0000${stateKey}`);
    if (!found) return errorOf(404, 'M_NOT_FOUND', 'State event not found');
    return response(200, found);
   }
   return errorOf(404, 'M_UNRECOGNIZED', `No handler for ${rest}`);
  }
  const joinMatch = /^\/_matrix\/client\/v3\/join\/([^/]+)$/.exec(path);
  if (joinMatch) {
   if (!user) return errorOf(401, 'M_UNKNOWN_TOKEN', 'Invalid access token');
   const room = rooms.get(decodeURIComponent(joinMatch[1]!));
   if (!room) return errorOf(404, 'M_NOT_FOUND', 'Unknown room');
   if (room.joinRule === 'invite' && !room.members.has(user.userId)) return errorOf(403, 'M_FORBIDDEN', 'You are not invited to this room');
   membership(room, user.userId, 'join');
   room.members.set(user.userId, 'join');
   return response(200, {room_id: room.roomId});
  }

  // --- sync: a cursor and the events after it -------------------------------------------------------------------
  if (path === '/_matrix/client/v3/sync') {
   if (!user) return errorOf(401, 'M_UNKNOWN_TOKEN', 'Invalid access token');
   const since = Number((parsed.searchParams.get('since') ?? 's0').replace(/^s/, '')) || 0;
   const join: Record<string, unknown> = {};
   for (const room of rooms.values()) {
    if (!memberOf(room, user.userId)) continue;
    join[room.roomId] = {timeline: {events: room.log.filter(entry => entry.seq > since).map(entry => entry.event)}};
   }
   return response(200, {next_batch: `s${seq}`, rooms: {join}});
  }
  return errorOf(404, 'M_UNRECOGNIZED', `No handler for ${path}`);
 };

 return {
  serverName,
  secret,
  fetch: handle,
  users: () => [...users.keys()].sort(),
  tokenOf: userId => users.get(userId)?.token,
  rooms: () => [...rooms.keys()].sort(),
  events: roomId => (rooms.get(roomId)?.log ?? []).map(entry => entry.event),
  send: (roomId, sender, type, content) => {
   const room = rooms.get(roomId);
   if (!room) throw new Error(`Sala desconhecida: ${roomId}`);
   const event = eventOf(room, sender, type, content);
   return event.event_id;
  },
  inject: (roomId, event) => {
   const room = rooms.get(roomId);
   if (!room) throw new Error(`Sala desconhecida: ${roomId}`);
   const built: FakeEvent = {event_id: `$forged${++nextEvent}:${serverName}`, origin_server_ts: 1_700_000_000_000 + nextEvent, room_id: roomId, sender: `@forged:${serverName}`, ...event};
   room.log.push({event: built, seq: ++seq});
   // A state event is state: injecting one is how a test changes what a later read observes, exactly like the room
   // changing under the client.
   if (built.state_key !== undefined) room.state.set(`${built.type}\u0000${built.state_key}`, built.content);
   return built.event_id;
  },
  requests: () => requests,
  fail: (matcher, status, errcode, error) => { failures.push({matcher, status, errcode, error}); },
  clearFailures: () => { failures.length = 0; },
 };
}
