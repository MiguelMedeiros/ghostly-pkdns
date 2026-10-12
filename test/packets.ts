/** Test helpers: a key pair, a DNS packet builder and a Pkarr payload signed as a publisher signs it. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeName } from "../src/lib/dnswire";
import { zbase32Encode } from "../src/lib/zbase32";

export interface TestKey {
  secret: Uint8Array;
  publicBytes: Uint8Array;
  /** The public key in z-base32, as a person pastes it. */
  key: string;
}

/** A key pair from a fixed seed byte, so a failing test shows the same bytes every run. */
export function testKey(seed = 7): TestKey {
  const secret = new Uint8Array(32).fill(seed);
  const publicBytes = ed25519.getPublicKey(secret);
  return { secret, publicBytes, key: zbase32Encode(publicBytes) };
}

export interface TestRecord {
  name: string;
  type: number;
  ttl?: number;
  data: Uint8Array;
}

const u16 = (n: number) => [n >> 8, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A response packet with these answers and no questions, as Pkarr publishes. */
export function dnsPacket(records: TestRecord[], questions: { name: string; type: number }[] = []): Uint8Array {
  const out: number[] = [0, 0, 0x84, 0, ...u16(questions.length), ...u16(records.length), 0, 0, 0, 0];
  for (const q of questions) out.push(...encodeName(q.name), ...u16(q.type), 0, 1);
  for (const r of records) out.push(...encodeName(r.name), ...u16(r.type), 0, 1, ...u32(r.ttl ?? 300), ...u16(r.data.length), ...r.data);
  return Uint8Array.from(out);
}

export const txt = (text: string): Uint8Array => {
  const bytes = new TextEncoder().encode(text);
  return Uint8Array.from([bytes.length, ...bytes]);
};

/** The bytes a Pkarr publisher signs (BEP 44, no salt). Written here on its own, apart from the app's. */
export function signableBytes(timestampMicros: bigint, dns: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(`3:seqi${timestampMicros}e1:v${dns.length}:`);
  const out = new Uint8Array(head.length + dns.length);
  out.set(head);
  out.set(dns, head.length);
  return out;
}

/** A relay payload: signature, timestamp, packet. */
export function signedPayload(key: TestKey, timestampMicros: bigint, dns: Uint8Array): Uint8Array {
  const out = new Uint8Array(72 + dns.length);
  out.set(ed25519.sign(signableBytes(timestampMicros, dns), key.secret));
  new DataView(out.buffer).setBigUint64(64, timestampMicros);
  out.set(dns, 72);
  return out;
}

/** Microseconds for a date. */
export const micros = (iso: string): bigint => BigInt(Date.parse(iso)) * 1000n;
