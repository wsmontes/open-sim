import type {IdentityProof, IdentityProvider, Proof, SessionBindingRequest, SignatureVerifier} from '../../world/permissions';
import {identityBytes} from '../../world/permissions';
import type {WorldResult} from '../../world/model';
import {failed, ok} from '../../world/model';
import type {WorldCodec} from '../../world/ports';

// Ed25519 through WebCrypto (crypto.subtle), available in Node 22+ and Chromium. No hand-rolled cryptography: keys are
// imported as JWK — the only portable form that carries the public half next to the private seed — and the platform
// signs and verifies. The world contract only ever sees hex key material, signatures and the bytes they cover, so the
// algorithm can be replaced with another wire version without touching identity, grants or authorization.

export type KeyPair = {publicKey: string; secretKey: string};
const PUBLIC_KEY = /^[0-9a-f]{64}$/, SIGNATURE_HEX = /^[0-9a-f]{128}$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toHex(bytes: Uint8Array): string {
 let text = '';
 for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
 return text;
}
function fromHex(text: string): Uint8Array {
 if (text.length % 2) throw new Error('Hexadecimal ímpar');
 const bytes = new Uint8Array(text.length / 2);
 for (let index = 0; index < bytes.length; index += 1) {
  const part = text.slice(index * 2, index * 2 + 2);
  const value = Number.parseInt(part, 16);
  if (Number.isNaN(value)) throw new Error(`Hexadecimal inválido: ${part}`);
  bytes[index] = value;
 }
 return bytes;
}
// JWK carries base64url without padding; the byte-level implementation keeps this adapter free of Buffer and btoa.
function toBase64Url(bytes: Uint8Array): string {
 let text = '';
 for (let index = 0; index < bytes.length; index += 3) {
  const first = bytes[index]!, second = bytes[index + 1], third = bytes[index + 2];
  text += ALPHABET[first >> 2]!;
  text += ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)]!;
  if (second === undefined) break;
  text += ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)]!;
  if (third === undefined) break;
  text += ALPHABET[third & 0x3f]!;
 }
 return text;
}
function fromBase64Url(text: string): Uint8Array {
 const bytes: number[] = [];
 let accumulator = 0, bits = 0;
 for (const character of text) {
  const value = ALPHABET.indexOf(character);
  if (value < 0) throw new Error(`Base64url inválido: ${character}`);
  accumulator = ((accumulator << 6) | value) & 0xffff;
  bits += 6;
  if (bits >= 8) {
   bits -= 8;
   bytes.push((accumulator >> bits) & 0xff);
  }
 }
 return Uint8Array.from(bytes);
}
const EDITOR = {name: 'Ed25519'};
// WebCrypto wants a view backed by a plain ArrayBuffer; the extra copy is cheap next to a signature and keeps this
// usable when the caller hands over a view into a larger buffer.
function copyOf(bytes: Uint8Array) {
 const copy = new Uint8Array(bytes.byteLength);
 copy.set(bytes);
 return copy;
}
// A public key is imported once per hex value: a host verifies every incoming proposal against the same session key.
const publicKeys = new Map<string, Promise<CryptoKey>>();
function publicKeyOf(hex: string): Promise<CryptoKey> {
 const cached = publicKeys.get(hex);
 if (cached) return cached;
 const imported = crypto.subtle.importKey('raw', copyOf(fromHex(hex)), EDITOR, false, ['verify']).catch(error => {
  publicKeys.delete(hex);
  throw error;
 });
 publicKeys.set(hex, imported);
 return imported;
}
const secretKeys = new Map<string, Promise<CryptoKey>>();
function secretKeyOf(pair: KeyPair): Promise<CryptoKey> {
 const cached = secretKeys.get(pair.secretKey);
 if (cached) return cached;
 const imported = crypto.subtle.importKey('jwk', {kty: 'OKP', crv: 'Ed25519', x: toBase64Url(fromHex(pair.publicKey)), d: toBase64Url(fromHex(pair.secretKey))}, EDITOR, false, ['sign']).catch(error => {
  secretKeys.delete(pair.secretKey);
  throw error;
 });
 secretKeys.set(pair.secretKey, imported);
 return imported;
}

export async function generateSessionKeyPair(): Promise<KeyPair> {
 const pair = await crypto.subtle.generateKey(EDITOR, true, ['sign', 'verify']);
 if (!('privateKey' in pair)) throw new Error('Ed25519 sem par de chaves');
 const exported = await crypto.subtle.exportKey('jwk', pair.privateKey);
 const publicPart = exported.x, secretPart = exported.d;
 if (typeof publicPart !== 'string' || typeof secretPart !== 'string') throw new Error('Chave Ed25519 sem material exportável');
 return {publicKey: toHex(fromBase64Url(publicPart)), secretKey: toHex(fromBase64Url(secretPart))};
}
export async function signEd25519(pair: KeyPair, bytes: Uint8Array): Promise<string> {
 return toHex(new Uint8Array(await crypto.subtle.sign(EDITOR, await secretKeyOf(pair), copyOf(bytes))));
}
// Both proofs carry the key and the signature the verifier has to check, and the caller hands over the exact bytes:
// an invalid shape, a wrong length or a key that does not match the signature is a refusal, never an exception.
export function ed25519Verifier(): SignatureVerifier {
 return {
  verify: async (proof: Proof, bytes: Uint8Array): Promise<boolean> => {
   const algorithm = proof.kind === 'identity' ? proof.delegation.algorithm : proof.algorithm;
   const key = proof.kind === 'identity' ? proof.delegation.key : proof.sessionKey;
   const signature = proof.kind === 'identity' ? proof.delegation.value : proof.signature;
   if (algorithm !== 'Ed25519') return false;
   if (!PUBLIC_KEY.test(key) || !SIGNATURE_HEX.test(signature)) return false;
   try {
    return await crypto.subtle.verify(EDITOR, await publicKeyOf(key), copyOf(fromHex(signature)), copyOf(bytes));
   } catch {
    return false;
   }
  },
 };
}
// The reference identity provider for a local key holder: the root key signs a short-lived session key bound to one
// world, branch and session. A local principal is its root key, so claiming a local identity with another root key is
// refused before a proof is ever produced.
export function localIdentityProvider(keys: {root: KeyPair; session: KeyPair; codec: WorldCodec}): IdentityProvider {
 return {
  bindSession: async (request: SessionBindingRequest): Promise<WorldResult<IdentityProof>> => {
   if (request.principal.scheme === 'local' && request.principal.id !== keys.root.publicKey) return failed('MALFORMED', 'Principal local não corresponde à chave raiz');
   const unsigned: IdentityProof = {kind: 'identity', principal: request.principal, sessionKey: keys.session.publicKey, scope: request.scope, delegation: {algorithm: 'Ed25519', key: keys.root.publicKey, value: ''}};
   return ok({...unsigned, delegation: {algorithm: 'Ed25519', key: keys.root.publicKey, value: await signEd25519(keys.root, identityBytes(unsigned, keys.codec))}});
  },
 };
}
