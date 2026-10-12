/**
 * Ordinary domain names, looked up over DNS over HTTPS (RFC 8484) at a resolver the person picks.
 *
 * The query goes as `GET <endpoint>?dns=<base64url packet>` with no header of the app's own, which keeps it a
 * "simple" cross-origin request: no preflight, and the three resolvers below answer it with
 * `Access-Control-Allow-Origin: *` (measured 2026-10-12 from an opaque origin). The answer is a DNS packet, read by
 * the same parser as a Pkarr payload's. Unlike a Pkarr record, nothing here is signed for the app to check: the
 * resolver is believed, as any DNS resolver is. The page says which one answered.
 */
import { DNS_TYPE_NUMBERS, encodeQuery, parseDnsMessage } from "./dnswire";
import type { DohProviderId } from "./model";
import { type DnsRecord, recordsOf } from "./records";
import { readCapped } from "./resolver";

export interface DohProvider {
  id: DohProviderId;
  name: string;
  endpoint: string;
}

export const DOH: Readonly<Record<DohProviderId, DohProvider>> = {
  cloudflare: { id: "cloudflare", name: "Cloudflare (1.1.1.1)", endpoint: "https://cloudflare-dns.com/dns-query" },
  google: { id: "google", name: "Google (8.8.8.8)", endpoint: "https://dns.google/dns-query" },
  quad9: { id: "quad9", name: "Quad9 (9.9.9.9)", endpoint: "https://dns.quad9.net/dns-query" },
};

/** The record types asked for a name, each its own query. */
export const DOH_TYPES = ["A", "AAAA", "CNAME", "TXT", "HTTPS", "SVCB"] as const;

/** A DNS answer over HTTPS is at most 64 KiB. */
const MAX_ANSWER_BYTES = 65_535;

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A host name out of what a person typed (a name, or a URL with one), lowercase and in its ASCII form, or null when
 * it is not a name with a dot: an IP address, one label, or anything with characters a host name cannot have.
 */
export function domainOf(input: string): string | null {
  const text = input.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
  if (!text || text.length > 253 || /[\s@:\\]/.test(text)) return null;
  let host: string;
  try {
    host = new URL(`https://${text}`).hostname;
  } catch {
    return null;
  }
  if (!/^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) return null;
  return host;
}

export interface DohResult {
  name: string;
  provider: DohProvider;
  records: DnsRecord[];
  /** The time until the last answer came. */
  responseTimeMs: number;
  /** True when the resolver said the name does not exist. */
  noSuchName: boolean;
  /** Types whose query failed (the others still show). */
  failed: string[];
}

/** One answer packet as records, checked to be the answer to that question. */
export function readDohAnswer(bytes: Uint8Array, name: string, type: number): { records: DnsRecord[]; rcode: number } {
  const message = parseDnsMessage(bytes);
  if ((message.flags & 0x8000) === 0) throw new Error("not a response");
  const question = message.questions[0];
  if (!question || question.type !== type || question.name.toLowerCase() !== name.toLowerCase()) throw new Error("the answer is to another question");
  return { records: recordsOf(message), rcode: message.rcode };
}

export async function dohLookup(input: string, provider: DohProvider, timeoutMs: number, doFetch: typeof fetch = fetch): Promise<DohResult> {
  const name = domainOf(input);
  if (!name) throw new Error("bad-name");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const start = performance.now();
  try {
    const answers = await Promise.allSettled(
      DOH_TYPES.map(async (type) => {
        const number = DNS_TYPE_NUMBERS[type];
        const url = `${provider.endpoint}?dns=${base64url(encodeQuery(name, number))}`;
        const response = await doFetch(url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return readDohAnswer(await readCapped(response, MAX_ANSWER_BYTES), name, number);
      }),
    );
    const records: DnsRecord[] = [];
    const seen = new Set<string>();
    const failed: string[] = [];
    let noSuchName = false;
    answers.forEach((answer, i) => {
      if (answer.status === "rejected") return void failed.push(DOH_TYPES[i]);
      if (answer.value.rcode === 3) noSuchName = true;
      // A CNAME comes with every type's answer: once is enough.
      for (const record of answer.value.records) {
        const id = `${record.type} ${record.name} ${record.value}`;
        if (!seen.has(id)) records.push(record);
        seen.add(id);
      }
    });
    if (failed.length === DOH_TYPES.length) throw new Error("unreachable");
    return { name, provider, records, responseTimeMs: Math.round(performance.now() - start), noSuchName, failed };
  } finally {
    clearTimeout(timeout);
  }
}
