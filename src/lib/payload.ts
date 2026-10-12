/**
 * A relay's answer for a key (the Pkarr relay payload), checked before anything in it is believed:
 *
 *   [0..64)   Ed25519 signature
 *   [64..72)  timestamp, big-endian u64, microseconds since the epoch
 *   [72..)    DNS packet, at most 1000 bytes
 *
 * The signature is the key owner's, over the BEP 44 form of the record (the timestamp as `seq`, the packet as `v`,
 * no salt), exactly as Pkarr defines it: `3:seqi<timestamp>e1:v<length>:<packet>`. A relay only carries the bytes, so
 * it is never trusted: an answer whose signature does not verify under the key that was asked for is refused, and so
 * is one older than the newest already seen for that key (a relay replaying an old record), one dated far in the
 * future, and one whose packet does not read as DNS.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { DnsParseError, parseDnsMessage } from "./dnswire";
import { type DnsRecord, recordsOf } from "./records";
import { decodePublicKey } from "./zbase32";

export const SIGNATURE_BYTES = 64;
export const TIMESTAMP_BYTES = 8;
export const DNS_OFFSET = SIGNATURE_BYTES + TIMESTAMP_BYTES;
/** Pkarr's bound on the packet. */
export const MAX_DNS_BYTES = 1000;
/** How far ahead of this device's clock a record may be dated: clocks drift, publishers' too. */
export const MAX_FUTURE_MS = 2 * 60 * 60 * 1000;

/**
 * Why an answer was refused:
 * - `too-short`: not even a signature, a timestamp and a DNS header.
 * - `too-large`: a packet over 1000 bytes.
 * - `bad-key`: the key asked for is not 32 bytes of z-base32.
 * - `bad-signature`: not signed by the key's owner, or changed since.
 * - `bad-packet`: signed, but not a DNS packet that can be read to its end.
 * - `stale`: older than the newest record already seen for the key.
 * - `future`: dated more than two hours ahead.
 */
export type PayloadRefusal = "too-short" | "too-large" | "bad-key" | "bad-signature" | "bad-packet" | "stale" | "future";

export class PayloadError extends Error {
  constructor(readonly code: PayloadRefusal, message: string) {
    super(message);
    this.name = "PayloadError";
  }
}

export interface VerifiedPayload {
  publicKey: string;
  /** The record's timestamp as signed. Compared as it is: a number would round it. */
  timestampMicros: bigint;
  /** The same in milliseconds, for a Date. */
  timestampMs: number;
  records: DnsRecord[];
  /** The whole payload's size in bytes. */
  rawSize: number;
}

export interface VerifyOptions {
  /** The newest timestamp already seen for this key: anything older is refused. */
  newestSeenMicros?: bigint;
  /** This device's clock (Date.now() by default). */
  nowMs?: number;
  maxFutureMs?: number;
}

/** The bytes the key's owner signed for this timestamp and packet. */
export function signable(timestampMicros: bigint, dns: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(`3:seqi${timestampMicros}e1:v${dns.length}:`);
  const out = new Uint8Array(head.length + dns.length);
  out.set(head);
  out.set(dns, head.length);
  return out;
}

/** The payload's records, once every check has passed. Throws a PayloadError otherwise. */
export function verifyPayload(publicKey: string, payload: Uint8Array, options: VerifyOptions = {}): VerifiedPayload {
  const keyBytes = decodePublicKey(publicKey);
  if (!keyBytes) throw new PayloadError("bad-key", "not a Pkarr public key");
  if (payload.length < DNS_OFFSET + 12) throw new PayloadError("too-short", `${payload.length} bytes, at least ${DNS_OFFSET + 12} needed`);
  const dns = payload.subarray(DNS_OFFSET);
  if (dns.length > MAX_DNS_BYTES) throw new PayloadError("too-large", `a packet of ${dns.length} bytes, over ${MAX_DNS_BYTES}`);

  const signature = payload.subarray(0, SIGNATURE_BYTES);
  const timestampMicros = new DataView(payload.buffer, payload.byteOffset + SIGNATURE_BYTES, TIMESTAMP_BYTES).getBigUint64(0);
  let signed = false;
  try {
    // Strict RFC 8032 verification, as ed25519-dalek does it for Pkarr: no small-order or non-canonical encodings.
    signed = ed25519.verify(signature, signable(timestampMicros, dns), keyBytes, { zip215: false });
  } catch {
    signed = false;
  }
  if (!signed) throw new PayloadError("bad-signature", "the signature is not the key owner's");

  // From here on the bytes are the owner's. The timestamp is checked only now: unsigned, it would say anything.
  const now = options.nowMs ?? Date.now();
  const timestampMs = Number(timestampMicros / 1000n);
  if (timestampMs > now + (options.maxFutureMs ?? MAX_FUTURE_MS)) throw new PayloadError("future", "dated in the future");
  if (options.newestSeenMicros !== undefined && timestampMicros < options.newestSeenMicros) {
    throw new PayloadError("stale", "older than a record already seen for this key");
  }

  try {
    const message = parseDnsMessage(dns);
    return { publicKey, timestampMicros, timestampMs, records: recordsOf(message, publicKey), rawSize: payload.length };
  } catch (error) {
    if (error instanceof DnsParseError) throw new PayloadError("bad-packet", error.message);
    throw error;
  }
}
