import type {JsonValue} from '../../world/model';
import type {WorldCodec} from '../../world/ports';
import {hasLoneSurrogate} from '../../world/codec';

// RFC 8785 (JSON Canonicalization Scheme) in the form the world contract needs: UTF-8 bytes, no whitespace, no
// trailing newline, property names sorted by UTF-16 code unit and numbers in ECMAScript's shortest round-trip form.
// Pure and dependency-free, so every runtime in this project (browser, Node, a future desktop host) can use it.
export function canonicalText(value: JsonValue): string {
 return write(value);
}
export function encodeJcs(value: JsonValue): Uint8Array {
 return new TextEncoder().encode(write(value));
}
export function createJcsCodec(): WorldCodec {
 return {encode: encodeJcs};
}
function write(value: JsonValue): string {
 if (value === null) return 'null';
 if (typeof value === 'boolean') return value ? 'true' : 'false';
 if (typeof value === 'number') {
  if (!Number.isFinite(value)) throw new Error('Número não finito não é JSON');
  return JSON.stringify(value);
 }
 if (typeof value === 'string') {
  if (hasLoneSurrogate(value)) throw new Error('Texto com substituto solto não é JSON portátil');
  return JSON.stringify(value);
 }
 if (Array.isArray(value)) return `[${value.map(write).join(',')}]`;
 const source = value as {[key: string]: JsonValue};
 return `{${Object.keys(source).sort().map(key => `${JSON.stringify(key)}:${write(source[key]!)}`).join(',')}}`;
}
