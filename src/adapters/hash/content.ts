// Large world snapshots and base chunks should be addressed by hash rather than shipped inside an event, so this is
// the one place that touches a platform API (WebCrypto, available in browsers and Node 20+). The core stays pure:
// it produces the canonical text, this adapter turns it into a content address.
export async function sha256Hex(text: string): Promise<string> {
 const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
 return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function contentRef(text: string): Promise<{hash: string; bytes: number}> {
 return {hash: await sha256Hex(text), bytes: new TextEncoder().encode(text).length};
}
