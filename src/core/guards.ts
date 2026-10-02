// Small questions every decoder of untrusted bytes asks, answered in one place each. These used to be copied into each
// reader, sometimes with a different meaning under the same name.

// The keys no decoded object may carry: assigning them on a plain object reaches the prototype instead of a field.
export const RESERVED_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

// `isPlainObject` is the decoder's question: is this a JSON object and nothing else? A class instance, a Map or an
// object with a forged prototype is refused, which is what every reader of untrusted bytes needs before it walks keys.
export function isPlainObject<T = unknown>(value: unknown): value is Record<string, T> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const proto: unknown = Object.getPrototypeOf(value);
 return proto === Object.prototype || proto === null;
}

// `isRecord` is the looser question: is this an object with keys, whatever made it? It is for values this process
// built itself, where the prototype is not an attack surface.
export function isRecord<T = unknown>(value: unknown): value is Record<string, T> {
 return !!value && typeof value === 'object' && !Array.isArray(value);
}

// A closed record: every key has to be one the contract declares. The refusal names the key, because a reader that
// silently dropped it would be handing on something other than what it was given.
export function closedProblem(value: Record<string, unknown>, allowed: readonly string[], label: string): string | null {
 for (const key of Object.keys(value)) {
  if (RESERVED_KEYS.includes(key)) return `${label} com campo reservado: ${key}`;
  if (!allowed.includes(key)) return `${label} com campo não declarado: ${key}`;
 }
 return null;
}
// The same rule for readers that report by throwing.
export function assertClosed(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
 for (const key of Object.keys(value)) {
  if (RESERVED_KEYS.includes(key)) throw new Error(`${label} com chave reservada: ${key}`);
  if (!allowed.includes(key)) throw new Error(`${label} com campo desconhecido: ${key}`);
 }
}

// What a caught value says, whether or not somebody threw an Error.
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
