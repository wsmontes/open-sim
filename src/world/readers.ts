// Field readers shared by every decoder that answers with a `WorldResult`: each takes an untrusted value and a label
// for the refusal, and either hands the value back typed or says which field was wrong.
import type {WorldResult} from './model';
import {failed,ok} from './model';

// A UTC instant to the second — the form signed documents carry, so two writers produce the same bytes.
export const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// A URI is anything that names its scheme; the readers below never rewrite one into another ecosystem's form.
export const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function stringOf(value: unknown, label: string, max = 200): WorldResult<string> {
 if (typeof value !== 'string' || !value.length || value.length > max) return failed('MALFORMED', `${label} inválido`);
 return ok(value);
}
export function uriOf(value: unknown, label: string): WorldResult<string> {
 const text = stringOf(value, label);
 if (!text.ok) return text;
 return URI_SCHEME.test(text.value) ? text : failed('MALFORMED', `${label} sem esquema: ${text.value}`);
}
export function instantOf(value: unknown, label: string): WorldResult<string> {
 if (typeof value !== 'string' || !UTC_INSTANT.test(value)) return failed('MALFORMED', `${label} fora do formato de instante`);
 return ok(value);
}
export function countOf(value: unknown, label: string, min = 0): WorldResult<number> {
 if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return failed('MALFORMED', `${label} inválido`);
 return ok(value);
}
export function hexOf(value: unknown, label: string, digits: number): WorldResult<string> {
 if (typeof value !== 'string' || value.length !== digits || !/^[0-9a-f]+$/.test(value)) return failed('MALFORMED', `${label} inválido`);
 return ok(value);
}
