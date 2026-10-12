/**
 * DNS wire format (RFC 1035), read and written without a library: the packet inside a Pkarr payload and the answers
 * of a DNS over HTTPS resolver are both this. Every read is bounds-checked: a packet cut short, a name that points
 * outside the packet or in a loop, or a record longer than what is left throws a DnsParseError.
 */

export class DnsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnsParseError";
  }
}

export const DNS_TYPES: Readonly<Record<number, string>> = {
  1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 15: "MX", 16: "TXT", 28: "AAAA", 33: "SRV", 64: "SVCB", 65: "HTTPS",
};

export const DNS_TYPE_NUMBERS: Readonly<Record<string, number>> = Object.fromEntries(Object.entries(DNS_TYPES).map(([n, name]) => [name, Number(n)]));

/** The name of a record type, or "TYPE<n>" for one this app does not format. */
export function typeName(type: number): string {
  return DNS_TYPES[type] ?? `TYPE${type}`;
}

export interface WireRecord {
  name: string;
  type: number;
  class: number;
  ttl: number;
  /** Where the record's data starts in the packet, and its length. Names in it may point back into the packet. */
  rdataOffset: number;
  rdataLength: number;
}

export interface DnsMessage {
  id: number;
  flags: number;
  /** The response code (0 is no error, 3 is "no such name"). */
  rcode: number;
  questions: { name: string; type: number }[];
  answers: WireRecord[];
  /** The whole packet, which record data is read from. */
  bytes: Uint8Array;
}

const need = (bytes: Uint8Array, offset: number, length: number): void => {
  if (offset < 0 || offset + length > bytes.length) throw new DnsParseError(`the packet ends at byte ${bytes.length}, ${offset + length} needed`);
};
const u16 = (bytes: Uint8Array, offset: number): number => {
  need(bytes, offset, 2);
  return (bytes[offset] << 8) | bytes[offset + 1];
};
const u32 = (bytes: Uint8Array, offset: number): number => {
  need(bytes, offset, 4);
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
};

/** One label as text: printable ASCII as it is, a dot or backslash escaped, any other byte as \DDD (RFC 1035, 5.1). */
function labelText(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    if (byte === 0x2e || byte === 0x5c) text += `\\${String.fromCharCode(byte)}`;
    else if (byte > 0x20 && byte < 0x7f) text += String.fromCharCode(byte);
    else text += `\\${String(byte).padStart(3, "0")}`;
  }
  return text;
}

/** The name at `offset`, following compression pointers, and the offset just after it. The root is ".". */
export function readName(bytes: Uint8Array, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let at = offset;
  let next = -1;
  let jumps = 0;
  let length = 0;
  for (;;) {
    need(bytes, at, 1);
    const len = bytes[at];
    if (len === 0) {
      at += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      need(bytes, at, 2);
      const pointer = ((len & 0x3f) << 8) | bytes[at + 1];
      if (next < 0) next = at + 2;
      // A pointer goes only backwards in a well-formed packet; a count stops any loop a hostile one makes.
      if (pointer >= bytes.length || ++jumps > 64) throw new DnsParseError("a name's compression pointer leads nowhere");
      at = pointer;
      continue;
    }
    if (len & 0xc0) throw new DnsParseError("a label of an unknown kind");
    need(bytes, at + 1, len);
    length += len + 1;
    if (length > 255) throw new DnsParseError("a name longer than 255 bytes");
    labels.push(labelText(bytes.subarray(at + 1, at + 1 + len)));
    at += 1 + len;
  }
  return { name: labels.length ? labels.join(".") : ".", next: next < 0 ? at : next };
}

/** A DNS packet's header, questions and answers. Authority and additional records are not read. */
export function parseDnsMessage(bytes: Uint8Array): DnsMessage {
  if (bytes.length < 12) throw new DnsParseError(`a DNS packet has at least 12 bytes, this one ${bytes.length}`);
  const id = u16(bytes, 0);
  const flags = u16(bytes, 2);
  const questionCount = u16(bytes, 4);
  const answerCount = u16(bytes, 6);
  let at = 12;
  const questions: DnsMessage["questions"] = [];
  for (let i = 0; i < questionCount; i++) {
    const { name, next } = readName(bytes, at);
    questions.push({ name, type: u16(bytes, next) });
    need(bytes, next, 4);
    at = next + 4;
  }
  const answers: WireRecord[] = [];
  for (let i = 0; i < answerCount; i++) {
    const { name, next } = readName(bytes, at);
    need(bytes, next, 10);
    const rdataLength = u16(bytes, next + 8);
    const rdataOffset = next + 10;
    need(bytes, rdataOffset, rdataLength);
    answers.push({ name, type: u16(bytes, next), class: u16(bytes, next + 2), ttl: u32(bytes, next + 4), rdataOffset, rdataLength });
    at = rdataOffset + rdataLength;
  }
  return { id, flags, rcode: flags & 0x0f, questions, answers, bytes };
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

const hex = (bytes: Uint8Array, limit = 32): string =>
  Array.from(bytes.subarray(0, limit), (b) => b.toString(16).padStart(2, "0")).join(" ") + (bytes.length > limit ? "..." : "");

function ipv4(bytes: Uint8Array): string {
  return Array.from(bytes).join(".");
}

/** An IPv6 address in its short form (RFC 5952): the longest run of zero groups, two or more, written as "::". */
export function ipv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const text = (part: number[]) => part.map((g) => g.toString(16)).join(":");
  if (bestLength < 2) return text(groups);
  return `${text(groups.slice(0, bestStart))}::${text(groups.slice(bestStart + bestLength))}`;
}

/** SVCB and HTTPS data (RFC 9460): priority, target, then parameters. */
function svcb(message: Uint8Array, offset: number, length: number): string {
  const end = offset + length;
  const priority = u16(message, offset);
  const { name: target, next } = readName(message, offset + 2);
  const params: string[] = [];
  let at = next;
  while (at + 4 <= end) {
    const key = u16(message, at);
    const valueLength = u16(message, at + 2);
    at += 4;
    if (at + valueLength > end) throw new DnsParseError("a service parameter longer than its record");
    const value = message.subarray(at, at + valueLength);
    at += valueLength;
    if (key === 0) params.push("mandatory");
    else if (key === 1) {
      const names: string[] = [];
      for (let i = 0; i < value.length; ) {
        const n = value[i];
        if (i + 1 + n > value.length) break;
        names.push(utf8.decode(value.subarray(i + 1, i + 1 + n)));
        i += 1 + n;
      }
      if (names.length) params.push(`alpn=${names.join(",")}`);
    } else if (key === 2) params.push("no-default-alpn");
    else if (key === 3 && value.length >= 2) params.push(`port=${(value[0] << 8) | value[1]}`);
    else if (key === 4) {
      const ips: string[] = [];
      for (let i = 0; i + 4 <= value.length; i += 4) ips.push(ipv4(value.subarray(i, i + 4)));
      if (ips.length) params.push(`ipv4hint=${ips.join(",")}`);
    } else if (key === 6) {
      const ips: string[] = [];
      for (let i = 0; i + 16 <= value.length; i += 16) ips.push(ipv6(value.subarray(i, i + 16)));
      if (ips.length) params.push(`ipv6hint=${ips.join(",")}`);
    } else {
      const text = utf8.decode(value);
      params.push(/^[\x20-\x7e]+$/.test(text) ? `key${key}=${text}` : `key${key}=0x${hex(value, value.length).replace(/ /g, "")}`);
    }
  }
  return params.length ? `${priority} ${target} ${params.join(" ")}` : `${priority} ${target}`;
}

/** A record's data as text, in the way a zone file would show it. An unknown type, or data of the wrong size, is hex. */
export function rdataText(message: Uint8Array, record: WireRecord): string {
  const { rdataOffset: at, rdataLength: length } = record;
  const data = message.subarray(at, at + length);
  switch (record.type) {
    case 1:
      return length === 4 ? ipv4(data) : hex(data);
    case 28:
      return length === 16 ? ipv6(data) : hex(data);
    case 2:
    case 5:
      return readName(message, at).name;
    case 16: {
      const parts: string[] = [];
      for (let i = 0; i < length; ) {
        const n = data[i];
        if (i + 1 + n > length) throw new DnsParseError("a text longer than its record");
        parts.push(utf8.decode(data.subarray(i + 1, i + 1 + n)));
        i += 1 + n;
      }
      return parts.join(" ");
    }
    case 15:
      return `${u16(message, at)} ${readName(message, at + 2).name}`;
    case 33:
      return `${u16(message, at)} ${u16(message, at + 2)} ${u16(message, at + 4)} ${readName(message, at + 6).name}`;
    case 6: {
      const mname = readName(message, at);
      const rname = readName(message, mname.next);
      return `${mname.name} ${rname.name} ${u32(message, rname.next)}`;
    }
    case 64:
    case 65:
      return svcb(message, at, length);
    default:
      return hex(data);
  }
}

/** A name in wire form. Throws on an empty label, a label over 63 bytes or a name over 255. */
export function encodeName(name: string): Uint8Array {
  const out: number[] = [];
  const encoder = new TextEncoder();
  for (const label of name.replace(/\.$/, "").split(".")) {
    if (name === "." || name === "") break;
    const bytes = encoder.encode(label);
    if (bytes.length === 0 || bytes.length > 63) throw new DnsParseError(`"${label}" is not a label of 1 to 63 bytes`);
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
  if (out.length > 255) throw new DnsParseError("a name longer than 255 bytes");
  return Uint8Array.from(out);
}

/** A query for one name and type, with recursion asked for and id 0 (RFC 8484 asks for 0, so answers cache). */
export function encodeQuery(name: string, type: number): Uint8Array {
  const qname = encodeName(name);
  const out = new Uint8Array(12 + qname.length + 4);
  out[2] = 0x01; // RD
  out[5] = 1; // one question
  out.set(qname, 12);
  out[12 + qname.length] = type >> 8;
  out[12 + qname.length + 1] = type & 255;
  out[12 + qname.length + 3] = 1; // class IN
  return out;
}
