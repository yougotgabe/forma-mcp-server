// Shared HMAC signing helpers for Formaut client-agent signed events.
// Cloudflare Worker compatible: uses Web Crypto only.

export async function hmacSha256Hex(secret, message) {
  if (!secret) throw new Error('HMAC secret is required');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyHmacSha256Hex(secret, message, expectedHex) {
  if (!expectedHex || typeof expectedHex !== 'string') return false;
  const actual = await hmacSha256Hex(secret, message);
  return timingSafeEqualHex(actual, expectedHex);
}

export function canonicalEventString(event = {}) {
  const copy = { ...event };
  delete copy.signature;
  return stableJsonStringify(copy);
}

export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function stableJsonStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(',')}}`;
}
