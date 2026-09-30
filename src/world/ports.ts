import type {JsonValue, ObjectRef} from './model';

// What the world layer asks a runtime for. The contract defines *which* bytes are canonical and *what* an address
// means; the adapter decides how they are produced, so another runtime can inject its own implementation without
// changing the format. The same applies to hashing: the world addresses content, it never hashes by itself.
export interface WorldCodec {
 encode(value: JsonValue): Uint8Array;
}
export interface ContentHasher {
 ref(bytes: Uint8Array): Promise<ObjectRef>;
}
