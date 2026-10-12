/** DNS records as the app shows them, and what they say about a key. Ported from the extension's lib/dns.ts. */
import { type DnsMessage, rdataText, typeName } from "./dnswire";

/** A record as the table shows it. `type` is "A", "TXT"…, or "TYPE<n>" for a type the app does not format. */
export interface DnsRecord {
  name: string;
  type: string;
  ttl: number;
  value: string;
}

const KEY_PATTERN = "[ybndrfg8ejkmcpqxot1uwisza345h769]{52}";

/** A record's name without the key at its end: "www.<key>" is "www", the key itself (or the root) is "@". */
export function cleanRecordName(name: string, publicKey?: string): string {
  if (!name || name === ".") return "@";
  if (publicKey && name.toLowerCase() === publicKey.toLowerCase()) return "@";
  if (new RegExp(`^${KEY_PATTERN}$`, "i").test(name)) return "@";
  return name.replace(new RegExp(`\\.${KEY_PATTERN}$`, "i"), "") || "@";
}

function isPkarrDomain(domain: string): boolean {
  return new RegExp(KEY_PATTERN, "i").test(domain);
}

/** The answers of a packet as records. With a key, names and name-valued data lose the key at their end. */
export function recordsOf(message: DnsMessage, publicKey?: string): DnsRecord[] {
  return message.answers.map((answer) => {
    let value = rdataText(message.bytes, answer);
    if (publicKey && (answer.type === 5 || answer.type === 2)) {
      const lower = value.toLowerCase();
      if (lower === publicKey) value = "@";
      else if (lower.endsWith(`.${publicKey}`)) value = value.slice(0, -publicKey.length - 1);
    }
    return { name: publicKey ? cleanRecordName(answer.name, publicKey) : answer.name, type: typeName(answer.type), ttl: answer.ttl, value };
  });
}

/** A `_pubky` record says the key is a Pubky user. */
export function hasPubkyProfile(records: DnsRecord[]): boolean {
  return records.some((r) => r.name === "_pubky");
}

export function getPubkyProfileUrl(publicKey: string): string {
  return `https://pubky.app/profile/${publicKey}`;
}

/**
 * A URL a browser could open, from a key's records, or null. In order: an HTTPS/SVCB record that names a real domain,
 * the root's A/AAAA, a CNAME to a real domain, any A/AAAA.
 */
export function extractWebUrl(records: DnsRecord[]): string | null {
  const host = (r: DnsRecord) => (r.type === "AAAA" ? `[${r.value}]` : r.value);
  for (const r of records) {
    if (r.type !== "HTTPS" && r.type !== "SVCB") continue;
    const parts = r.value.split(/\s+/);
    const target = parts[1];
    if (!target || target === "." || isPkarrDomain(target)) continue;
    const port = parts.find((p) => p.startsWith("port="))?.split("=")[1];
    return port && port !== "443" ? `https://${target}:${port}` : `https://${target}`;
  }
  for (const r of records) {
    if ((r.type === "A" || r.type === "AAAA") && r.name === "@") return `http://${host(r)}`;
  }
  for (const r of records) {
    if (r.type === "CNAME" && r.value && r.value !== "@" && r.value.includes(".") && !isPkarrDomain(r.value)) return `https://${r.value}`;
  }
  for (const r of records) {
    if (r.type === "A" || r.type === "AAAA") return `http://${host(r)}`;
  }
  return null;
}
