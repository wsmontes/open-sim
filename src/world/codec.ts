import type {JsonValue} from '../world/model';
import type {ContentHasher, WorldCodec} from './ports';
import {MAX_BUNDLE_BYTES, MAX_DEPTH, MAX_OBJECT_BYTES, WIRE_VERSION, WORLD_PROTOCOL, failed, isRef, ok, sameRef} from '../world/model';
import type {DatasetTerm, ObjectRef, WorldBundle, WorldDefinition, WorldObject, WorldResult} from '../world/model';
import {assertClosed,isPlainObject,} from '../core/guards';

// Reading a foreign file must not trust anything: size first, then a strict parse, then the shape, and only then the
// hashes. A duplicate JSON key is refused rather than silently resolved, because two readers disagreeing about the
// last-wins value is how a signed document stops meaning one thing.
// The critical schemas here are closed: adding a field to the envelope, the definition, a head or a reference is a new
// wireVersion that an older client refuses outright, instead of a field it silently ignores. Profiles still keep
// whatever they want in an object's value and in the bundle's `extensions`, which this client preserves untouched.
export type DecodeLimits = {maxBundleBytes: number; maxObjectBytes: number; maxDepth: number; maxNodes: number};
export const DEFAULT_LIMITS: DecodeLimits = {maxBundleBytes: MAX_BUNDLE_BYTES, maxObjectBytes: MAX_OBJECT_BYTES, maxDepth: MAX_DEPTH, maxNodes: 4_000_000};
export function decodeBundle(bytes: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): WorldResult<WorldBundle> {
 if (bytes.byteLength > limits.maxBundleBytes) return failed('LIMIT', `Pacote com ${bytes.byteLength} bytes excede o limite de ${limits.maxBundleBytes}`);
 // UTF-8 is decoded here rather than by a platform API: the world contract owns its wire format, and this layer
 // compiles without DOM and without Node types.
 const decoded = decodeUtf8(bytes);
 if (!decoded.ok) return decoded;
 const parsed = parseStrictJson(decoded.value, limits.maxDepth, limits.maxNodes);
 if (!parsed.ok) return parsed;
 try {
  return bundleFrom(parsed.value, limits);
 } catch (error) {
  return failed('MALFORMED', error instanceof Error ? error.message : 'Pacote inválido');
 }
}
export function encodeBundle(bundle: WorldBundle, codec: WorldCodec): Uint8Array {
 return codec.encode(bundle as unknown as JsonValue);
}
// Addresses are only worth trusting after the bytes are in hand: re-encode the value and compare with the reference.
export async function verifyBundle(bundle: WorldBundle, hasher: ContentHasher, codec: WorldCodec): Promise<WorldResult<WorldBundle>> {
 for (const object of bundle.objects) {
  const size = object.ref.bytes;
  if (size > MAX_OBJECT_BYTES) return failed('LIMIT', `Objeto de ${size} bytes excede o limite de ${MAX_OBJECT_BYTES}`);
  if (!sameRef(object.ref, await hasher.ref(codec.encode(object.value)))) return failed('HASH_MISMATCH', `Objeto ${object.ref.hash.slice(0, 12)}… não corresponde ao conteúdo`);
 }
 if (!bundle.completeness.complete) {
  for (const missing of bundle.completeness.missing) if (bundle.objects.some(object => sameRef(object.ref, missing))) return failed('MALFORMED', 'Pacote lista como ausente um objeto que ele contém');
 }
 return ok(bundle);
}
// --- strict JSON parsing ---------------------------------------------------------------------------------------
type Parsed = WorldResult<JsonValue>;
class Reader {
 private index = 0;
 private nodes = 0;
 constructor(private readonly text: string, private readonly maxDepth: number, private readonly maxNodes: number) {}
 parse(): Parsed {
  const value = this.value(0);
  if (!value.ok) return value;
  this.space();
  if (this.index !== this.text.length) return failed('MALFORMED', 'Conteúdo depois do fim do JSON');
  return value;
 }
 private space(): void {
  while (this.index < this.text.length) {
   const code = this.text.charCodeAt(this.index);
   if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) this.index += 1;
   else break;
  }
 }
 private value(depth: number): Parsed {
  if (depth > this.maxDepth) return failed('LIMIT', `JSON com profundidade acima de ${this.maxDepth}`);
  this.nodes += 1;
  if (this.nodes > this.maxNodes) return failed('LIMIT', 'JSON com nós demais');
  this.space();
  const char = this.text[this.index];
  if (char === undefined) return failed('MALFORMED', 'JSON termina antes do valor');
  if (char === '{') return this.object(depth);
  if (char === '[') return this.array(depth);
  if (char === '"') {
   const string = this.string();
   return string.ok ? ok(string.value) : string;
  }
  if (this.text.startsWith('true', this.index)) {this.index += 4;return ok(true);}
  if (this.text.startsWith('false', this.index)) {this.index += 5;return ok(false);}
  if (this.text.startsWith('null', this.index)) {this.index += 4;return ok(null);}
  return this.number();
 }
 private object(depth: number): Parsed {
  this.index += 1;
  const result: {[key: string]: JsonValue} = {}, seen = new Set<string>();
  this.space();
  if (this.text[this.index] === '}') {this.index += 1;return ok(result);}
  for (;;) {
   this.space();
   if (this.text[this.index] !== '"') return failed('MALFORMED', 'Nome de propriedade esperado');
   const key = this.string();
   if (!key.ok) return key;
   if (seen.has(key.value)) return failed('MALFORMED', `Nome de propriedade repetido: ${key.value}`);
   seen.add(key.value);
   this.space();
   if (this.text[this.index] !== ':') return failed('MALFORMED', `Falta ":" depois de ${key.value}`);
   this.index += 1;
   const item = this.value(depth + 1);
   if (!item.ok) return item;
   result[key.value] = item.value;
   this.space();
   const char = this.text[this.index];
   if (char === ',') {this.index += 1;continue;}
   if (char === '}') {this.index += 1;return ok(result);}
   return failed('MALFORMED', 'Falta "," ou "}" no objeto');
  }
 }
 private array(depth: number): Parsed {
  this.index += 1;
  const result: JsonValue[] = [];
  this.space();
  if (this.text[this.index] === ']') {this.index += 1;return ok(result);}
  for (;;) {
   const item = this.value(depth + 1);
   if (!item.ok) return item;
   result.push(item.value);
   this.space();
   const char = this.text[this.index];
   if (char === ',') {this.index += 1;continue;}
   if (char === ']') {this.index += 1;return ok(result);}
   return failed('MALFORMED', 'Falta "," ou "]" na lista');
  }
 }
 private string(): WorldResult<string> {
  this.index += 1;
  let out = '';
  for (;;) {
   const char = this.text[this.index];
   if (char === undefined) return failed('MALFORMED', 'Texto sem fechamento');
   const code = this.text.charCodeAt(this.index);
   if (code === 0x22) {this.index += 1;return loneSurrogate(out) ? failed('MALFORMED', 'Texto com substituto solto') : ok(out);}
   if (code === 0x5c) {
    const escape = this.text[this.index + 1];
    if (escape === 'u') {
     const hex = this.text.slice(this.index + 2, this.index + 6);
     if (!/^[0-9a-fA-F]{4}$/.test(hex)) return failed('MALFORMED', 'Escape unicode inválido');
     out += String.fromCharCode(Number.parseInt(hex, 16));
     this.index += 6;
     continue;
    }
    const simple: Record<string, string> = {'"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t'};
    const replacement = escape === undefined ? undefined : simple[escape];
    if (replacement === undefined) return failed('MALFORMED', `Escape inválido: \\${escape ?? ''}`);
    out += replacement;
    this.index += 2;
    continue;
   }
   if (code < 0x20) return failed('MALFORMED', 'Caractere de controle dentro do texto');
   out += char;
   this.index += 1;
  }
 }
 private number(): Parsed {
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.index));
  if (!match) return failed('MALFORMED', `Número inválido em "${this.text.slice(this.index, this.index + 12)}"`);
  const value = Number(match[0]);
  if (!Number.isFinite(value)) return failed('MALFORMED', `Número fora do intervalo: ${match[0]}`);
  this.index += match[0].length;
  return ok(value);
 }
}
function loneSurrogate(text: string): boolean {
 for (let i = 0; i < text.length; i += 1) {
  const code = text.charCodeAt(i);
  if (code >= 0xd800 && code <= 0xdbff) {
   const next = text.charCodeAt(i + 1);
   if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
   i += 1;
  } else if (code >= 0xdc00 && code <= 0xdfff) return true;
 }
 return false;
}
export function parseStrictJson(text: string, maxDepth = MAX_DEPTH, maxNodes = DEFAULT_LIMITS.maxNodes): Parsed {
 return new Reader(text, maxDepth, maxNodes).parse();
}

export function hasLoneSurrogate(text: string): boolean { return loneSurrogate(text); }
// Strict RFC 3629: refuse overlong forms, surrogates, code points above U+10FFFF and truncated sequences, so two
// readers can never disagree about which text a file contains.
export function decodeUtf8(bytes: Uint8Array): WorldResult<string> {
 let out = '';
 for (let index = 0; index < bytes.length;) {
  const byte = bytes[index]!;
  if (byte < 0x80) {out += String.fromCharCode(byte);index += 1;continue;}
  let extra = 0, code = 0;
  if (byte >= 0xc2 && byte <= 0xdf) {extra = 1;code = byte & 0x1f;}
  else if (byte >= 0xe0 && byte <= 0xef) {extra = 2;code = byte & 0x0f;}
  else if (byte >= 0xf0 && byte <= 0xf4) {extra = 3;code = byte & 0x07;}
  else return failed('MALFORMED', `Byte inválido em UTF-8: ${byte}`);
  if (index + extra >= bytes.length) return failed('MALFORMED', 'UTF-8 truncado');
  for (let step = 1; step <= extra; step += 1) {
   const next = bytes[index + step]!;
   if ((next & 0xc0) !== 0x80) return failed('MALFORMED', 'Sequência UTF-8 inválida');
   code = (code << 6) | (next & 0x3f);
  }
  const minimum = extra === 1 ? 0x80 : extra === 2 ? 0x800 : 0x10000;
  if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return failed('MALFORMED', 'Sequência UTF-8 inválida');
  out += String.fromCodePoint(code);
  index += extra + 1;
 }
 return ok(out);
}

// --- shape validation ------------------------------------------------------------------------------------------
// A critical object accepts exactly the fields this contract defines: anything else is a newer wire version, and an
// older client has to say so instead of quietly dropping it.
function extensionsFrom(value: unknown): Record<string, JsonValue> {
 if (value === undefined) return {};
 if (!isPlainObject(value)) throw new Error('extensões inválidas');
 return value as Record<string, JsonValue>;
}
function unknownFields(source: Record<string, unknown>, known: readonly string[]): Record<string, JsonValue> {
 const kept: Record<string, JsonValue> = {};
 for (const key of Object.keys(source)) if (!known.includes(key)) kept[key] = source[key] as JsonValue;
 return kept;
}
function bundleFrom(value: JsonValue, limits: DecodeLimits): WorldResult<WorldBundle> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Pacote não é um objeto');
 const envelope = value['envelope'];
 if (!isPlainObject(envelope)) return failed('MALFORMED', 'Pacote sem envelope');
 assertClosed(envelope, ['worldProtocol', 'wireVersion', 'kind'], 'Envelope');
 if (envelope['worldProtocol'] !== WORLD_PROTOCOL) return failed('WORLD_PROTOCOL_UNSUPPORTED', `Protocolo de mundo ${String(envelope['worldProtocol'])} não é suportado (esperado ${WORLD_PROTOCOL})`);
 if (envelope['wireVersion'] !== WIRE_VERSION) return failed('WIRE_VERSION_UNSUPPORTED', `Versão de transporte ${String(envelope['wireVersion'])} não é suportada (esperada ${WIRE_VERSION})`);
 if (envelope['kind'] !== 'bundle') return failed('MALFORMED', `Envelope de tipo desconhecido: ${String(envelope['kind'])}`);
 const definition = definitionFrom(value['definition']);
 if (!definition.ok) return definition;
 const head = value['head'] === undefined ? undefined : headFrom(value['head'], definition.value);
 if (head && !head.ok) return head;
 const objects = objectsFrom(value['objects'], limits);
 if (!objects.ok) return objects;
 const terms = termsFrom(value['terms']);
 if (!terms.ok) return terms;
 const completeness = completenessFrom(value['completeness'], objects.value);
 if (!completeness.ok) return completeness;
 return ok({
  envelope: {worldProtocol: 2, wireVersion: 1, kind: 'bundle'},
  definition: definition.value,
  ...(head ? {head: head.value} : {}),
  objects: objects.value,
  terms: terms.value,
  completeness: completeness.value,
  // Everything this contract does not define ends up in one explicit place, together with whatever the writer put
  // there on purpose; the writer's own entries win when a name collides.
  extensions: {...unknownFields(value, ['envelope', 'definition', 'head', 'objects', 'terms', 'completeness', 'extensions']), ...extensionsFrom(value['extensions'])},
 });
}
function addressPart(value: unknown, label: string): WorldResult<string> {
 if (typeof value !== 'string' || !value.length || value.length > 80) return failed('MALFORMED', `${label} inválido`);
 return ok(value);
}
function definitionFrom(value: unknown): WorldResult<WorldDefinition> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Pacote sem definição de mundo');
 const worldId = addressPart(value['worldId'], 'Mundo');
 if (!worldId.ok) return worldId;
 const branchId = addressPart(value['branchId'], 'Ramificação');
 if (!branchId.ok) return branchId;
 const rules = value['rules'];
 if (isPlainObject(rules)) assertClosed(rules, ['family', 'version'], 'Regras');
 if (!isPlainObject(rules) || typeof rules['family'] !== 'string' || !rules['family'] || !Number.isSafeInteger(rules['version']) || (rules['version'] as number) < 1) return failed('MALFORMED', 'Regras inválidas');
 const origin = value['origin'];
 if (isPlainObject(origin)) assertClosed(origin, ['kind', 'note', 'parent'], 'Origem');
 if (!isPlainObject(origin) || !['legacy-save', 'new', 'fork'].includes(String(origin['kind']))) return failed('MALFORMED', 'Origem inválida');
 const profiles = value['profiles'];
 if (!Array.isArray(profiles) || profiles.some(profile => typeof profile !== 'string' || !profile)) return failed('MALFORMED', 'Perfis inválidos');
 const parsedOrigin: WorldDefinition['origin'] = {kind: origin['kind'] as WorldDefinition['origin']['kind']};
 if (origin['note'] !== undefined) {
  if (typeof origin['note'] !== 'string') return failed('MALFORMED', 'Nota de origem inválida');
  parsedOrigin.note = origin['note'];
 }
 if (origin['parent'] !== undefined) {
  if (!isPlainObject(origin['parent'])) return failed('MALFORMED', 'Origem de fork inválida');
  const parentWorld = addressPart(origin['parent']['worldId'], 'Mundo de origem');
  if (!parentWorld.ok) return parentWorld;
  const parentBranch = addressPart(origin['parent']['branchId'], 'Ramificação de origem');
  if (!parentBranch.ok) return parentBranch;
  assertClosed(origin['parent'], ['worldId', 'branchId'], 'Origem de fork');
  parsedOrigin.parent = {worldId: parentWorld.value, branchId: parentBranch.value};
 }
 assertClosed(value, ['worldId', 'branchId', 'origin', 'profiles', 'rules'], 'Definição');
 return ok({worldId: worldId.value, branchId: branchId.value, origin: parsedOrigin, profiles: [...profiles] as string[], rules: {family: rules['family'], version: rules['version'] as number}});
}
function headFrom(value: unknown, definition: WorldDefinition): WorldResult<WorldBundle['head']> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Cabeça inválida');
 assertClosed(value, ['worldId', 'branchId', 'commit', 'generation'], 'Cabeça');
 const worldId = addressPart(value['worldId'], 'Mundo');
 if (!worldId.ok) return worldId;
 const branchId = addressPart(value['branchId'], 'Ramificação');
 if (!branchId.ok) return branchId;
 if (worldId.value !== definition.worldId || branchId.value !== definition.branchId) return failed('MALFORMED', 'Cabeça aponta para outro mundo ou ramificação');
 if (!isPlainObject(value['commit'])) return failed('MALFORMED', 'Referência de commit inválida');
 assertClosed(value['commit'], ['hash', 'bytes'], 'Referência de commit');
 if (!isRef(value['commit'])) return failed('MALFORMED', 'Referência de commit inválida');
 if (!Number.isSafeInteger(value['generation']) || (value['generation'] as number) < 0) return failed('MALFORMED', 'Geração inválida');
 return ok({worldId: worldId.value, branchId: branchId.value, commit: value['commit'] as unknown as ObjectRef, generation: value['generation'] as number});
}
function objectsFrom(value: unknown, limits: DecodeLimits): WorldResult<WorldObject[]> {
 if (!Array.isArray(value)) return failed('MALFORMED', 'Pacote sem objetos');
 const objects: WorldObject[] = [];
 for (const entry of value) {
  if (!isPlainObject(entry) || !isPlainObject(entry['ref'])) return failed('MALFORMED', 'Objeto sem referência de conteúdo');
 assertClosed(entry, ['ref', 'value'], 'Objeto');
 assertClosed(entry['ref'], ['hash', 'bytes'], 'Referência de objeto');
 if (!isRef(entry['ref'])) return failed('MALFORMED', 'Referência de objeto inválida');
  const ref = entry['ref'] as unknown as ObjectRef;
  if (ref.bytes > limits.maxObjectBytes) return failed('LIMIT', `Objeto de ${ref.bytes} bytes excede o limite de ${limits.maxObjectBytes}`);
  if(objects.some(existing => sameRef(existing.ref, ref))) return failed('MALFORMED', 'Pacote repete o mesmo objeto');
  objects.push({ref: {hash: ref.hash, bytes: ref.bytes}, value: entry['value'] as JsonValue});
 }
 return ok(objects);
}
function termsFrom(value: unknown): WorldResult<DatasetTerm[]> {
 if (!Array.isArray(value)) return failed('MALFORMED', 'Pacote sem termos de uso');
 const terms: DatasetTerm[] = [];
 for (const entry of value) {
  if (!isPlainObject(entry)) return failed('MALFORMED', 'Termo inválido');
  assertClosed(entry, ['source', 'attribution', 'license'], 'Termo');
  if (typeof entry['source'] !== 'string' || !entry['source']) return failed('MALFORMED', 'Termo sem fonte');
  const term: DatasetTerm = {source: entry['source']};
  for (const field of ['attribution', 'license'] as const) {
   if (entry[field] === undefined) continue;
   if (typeof entry[field] !== 'string') return failed('MALFORMED', `${field} inválido`);
   term[field] = entry[field] as string;
  }
  terms.push(term);
 }
 return ok(terms);
}
function completenessFrom(value: unknown, objects: WorldObject[]): WorldResult<WorldBundle['completeness']> {
 if (!isPlainObject(value) || typeof value['complete'] !== 'boolean' || !Array.isArray(value['missing'])) return failed('MALFORMED', 'Estado de completude inválido');
 assertClosed(value, ['complete', 'missing'], 'Completude');
 const missing: ObjectRef[] = [];
 for (const entry of value['missing']) {
  if (isPlainObject(entry)) assertClosed(entry, ['hash', 'bytes'], 'Referência ausente');
  if (!isRef(entry)) return failed('MALFORMED', 'Referência ausente inválida');
  missing.push(entry as unknown as ObjectRef);
 }
 const complete = value['complete'] as boolean;
 if (complete && missing.length) return failed('MALFORMED', 'Pacote completo não pode listar ausentes');
 if (!complete && !missing.length) return failed('MALFORMED', 'Pacote parcial precisa listar o que falta');
 if (!complete && objects.length) return failed('MALFORMED', 'Pacote parcial não transporta objetos');
 return ok({complete, missing});
}
