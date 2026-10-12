// DNS packets: read without a library, and refused when they do not hold what they say.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DnsParseError, encodeName, encodeQuery, ipv6, parseDnsMessage, readName, rdataText } from "../src/lib/dnswire";
import { base64url, domainOf, readDohAnswer } from "../src/lib/doh";
import { cleanRecordName, extractWebUrl, hasPubkyProfile, recordsOf } from "../src/lib/records";
import { dnsPacket, testKey, txt } from "./packets";

const key = testKey(3).key;
const name = (text: string) => encodeName(text);
const svcb = (priority: number, target: string, params: number[] = []) => Uint8Array.from([priority >> 8, priority & 255, ...name(target), ...params]);

describe("parsing a packet", () => {
  it("reads every record type the table shows", () => {
    const packet = dnsPacket([
      { name: key, type: 1, ttl: 60, data: Uint8Array.from([192, 0, 2, 1]) },
      { name: key, type: 28, data: Uint8Array.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) },
      { name: `www.${key}`, type: 5, data: name("example.com") },
      { name: `_pubky.${key}`, type: 16, data: Uint8Array.from([...txt("v=1"), ...txt("more")]) },
      { name: key, type: 2, data: name(`ns.${key}`) },
      { name: key, type: 15, data: Uint8Array.from([0, 10, ...name("mail.example.com")]) },
      { name: `_sip.${key}`, type: 33, data: Uint8Array.from([0, 1, 0, 2, 0x13, 0xc4, ...name("sip.example.com")]) },
      // alpn=h2,h3 port=8443 ipv4hint=192.0.2.9
      { name: key, type: 65, data: svcb(1, "svc.example.com", [0, 1, 0, 6, 2, 0x68, 0x32, 2, 0x68, 0x33, 0, 3, 0, 2, 0x20, 0xfb, 0, 4, 0, 4, 192, 0, 2, 9]) },
      { name: key, type: 64, data: svcb(0, ".") },
      { name: key, type: 99, data: Uint8Array.from([0xde, 0xad]) },
    ]);
    expect(recordsOf(parseDnsMessage(packet), key)).toEqual([
      { name: "@", type: "A", ttl: 60, value: "192.0.2.1" },
      { name: "@", type: "AAAA", ttl: 300, value: "2001:db8::1" },
      { name: "www", type: "CNAME", ttl: 300, value: "example.com" },
      { name: "_pubky", type: "TXT", ttl: 300, value: "v=1 more" },
      { name: "@", type: "NS", ttl: 300, value: "ns" },
      { name: "@", type: "MX", ttl: 300, value: "10 mail.example.com" },
      { name: "_sip", type: "SRV", ttl: 300, value: "1 2 5060 sip.example.com" },
      { name: "@", type: "HTTPS", ttl: 300, value: "1 svc.example.com alpn=h2,h3 port=8443 ipv4hint=192.0.2.9" },
      { name: "@", type: "SVCB", ttl: 300, value: "0 ." },
      { name: "@", type: "TYPE99", ttl: 300, value: "de ad" },
    ]);
  });

  it("follows a compression pointer, in a name and in a record's data", () => {
    // Header, then one answer whose name is at 12, then a CNAME whose data points back to it.
    const packet = Uint8Array.from([
      0, 0, 0x84, 0, 0, 0, 0, 2, 0, 0, 0, 0,
      3, 0x77, 0x77, 0x77, 7, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 3, 0x63, 0x6f, 0x6d, 0, // www.example.com at 12
      0, 1, 0, 1, 0, 0, 0, 5, 0, 4, 10, 0, 0, 1,
      1, 0x61, 0xc0, 16, // a.example.com, by pointer to "example.com" at 16
      0, 5, 0, 1, 0, 0, 0, 5, 0, 2, 0xc0, 12, // CNAME www.example.com
    ]);
    const message = parseDnsMessage(packet);
    expect(message.answers.map((a) => a.name)).toEqual(["www.example.com", "a.example.com"]);
    expect(rdataText(packet, message.answers[1])).toBe("www.example.com");
  });

  it("refuses a pointer that loops or leads outside the packet", () => {
    expect(() => readName(Uint8Array.from([0xc0, 0]), 0)).toThrow(DnsParseError);
    expect(() => readName(Uint8Array.from([0xc0, 2, 0xc0, 0]), 0)).toThrow(DnsParseError);
    expect(() => readName(Uint8Array.from([0xc0, 99]), 0)).toThrow(DnsParseError);
  });

  it("refuses a packet cut anywhere", () => {
    const packet = dnsPacket([
      { name: key, type: 1, data: Uint8Array.from([192, 0, 2, 1]) },
      { name: `t.${key}`, type: 16, data: txt("hello") },
    ]);
    expect(() => parseDnsMessage(packet)).not.toThrow();
    for (let length = 0; length < packet.length; length++) {
      expect(() => recordsOf(parseDnsMessage(packet.subarray(0, length))), `cut at ${length}`).toThrow(DnsParseError);
    }
  });

  it("refuses a text or a service parameter longer than its record", () => {
    const text = dnsPacket([{ name: key, type: 16, data: Uint8Array.from([9, 0x61]) }]);
    expect(() => recordsOf(parseDnsMessage(text))).toThrow(DnsParseError);
    const service = dnsPacket([{ name: key, type: 65, data: svcb(1, "a.example", [0, 3, 0, 9, 1]) }]);
    expect(() => recordsOf(parseDnsMessage(service))).toThrow(DnsParseError);
  });

  it("shows a byte that is not printable in a name as an escape, never as it is", () => {
    const packet = dnsPacket([{ name: "x", type: 1, data: Uint8Array.from([1, 2, 3, 4]) }]);
    packet[13] = 0x3c; // "<"
    expect(parseDnsMessage(packet).answers[0].name).toBe("<");
    packet[13] = 0x07;
    expect(parseDnsMessage(packet).answers[0].name).toBe("\\007");
    packet[13] = 0x2e;
    expect(parseDnsMessage(packet).answers[0].name).toBe("\\.");
  });

  it("writes IPv6 addresses in their short form", () => {
    const bytes = (groups: number[]) => Uint8Array.from(groups.flatMap((g) => [g >> 8, g & 255]));
    expect(ipv6(bytes([0, 0, 0, 0, 0, 0, 0, 0]))).toBe("::");
    expect(ipv6(bytes([0, 0, 0, 0, 0, 0, 0, 1]))).toBe("::1");
    expect(ipv6(bytes([0x2001, 0xdb8, 0, 1, 0, 0, 0, 1]))).toBe("2001:db8:0:1::1");
    expect(ipv6(bytes([1, 2, 3, 4, 5, 6, 7, 8]))).toBe("1:2:3:4:5:6:7:8");
  });
});

describe("what records say about a key", () => {
  it("cleans the key off a name", () => {
    expect(cleanRecordName(key, key)).toBe("@");
    expect(cleanRecordName(`www.${key}`, key)).toBe("www");
    expect(cleanRecordName(".", key)).toBe("@");
    expect(cleanRecordName("example.com", key)).toBe("example.com");
  });

  it("finds a site to visit, and a Pubky profile", () => {
    expect(extractWebUrl([{ name: "@", type: "HTTPS", ttl: 1, value: "1 home.example.com port=8443" }])).toBe("https://home.example.com:8443");
    expect(extractWebUrl([{ name: "@", type: "HTTPS", ttl: 1, value: "1 home.example.com port=443" }])).toBe("https://home.example.com");
    expect(extractWebUrl([{ name: "@", type: "HTTPS", ttl: 1, value: "1 ." }, { name: "@", type: "A", ttl: 1, value: "192.0.2.1" }])).toBe("http://192.0.2.1");
    expect(extractWebUrl([{ name: "@", type: "AAAA", ttl: 1, value: "2001:db8::1" }])).toBe("http://[2001:db8::1]");
    expect(extractWebUrl([{ name: "www", type: "CNAME", ttl: 1, value: "example.com" }])).toBe("https://example.com");
    expect(extractWebUrl([{ name: "www", type: "CNAME", ttl: 1, value: "@" }, { name: "_pubky", type: "TXT", ttl: 1, value: "x" }])).toBeNull();
    expect(hasPubkyProfile([{ name: "_pubky", type: "HTTPS", ttl: 1, value: "1 homeserver.example" }])).toBe(true);
    expect(hasPubkyProfile([{ name: "@", type: "A", ttl: 1, value: "192.0.2.1" }])).toBe(false);
  });
});

describe("DNS over HTTPS", () => {
  it("writes a query as RFC 8484 sends it", () => {
    // The example of RFC 8484, 4.1.1, is www.example.com A with id 0 and RD.
    expect(base64url(encodeQuery("www.example.com", 1))).toBe("AAABAAABAAAAAAAAA3d3dwdleGFtcGxlA2NvbQAAAQAB");
  });

  it("reads a real answer (Cloudflare, example.com A, recorded 2026-10-12)", () => {
    const bytes = new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures/doh-example-com-a.bin")));
    const { records, rcode } = readDohAnswer(bytes, "example.com", 1);
    expect(rcode).toBe(0);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record).toMatchObject({ name: "example.com", type: "A" });
      expect(record.value).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
  });

  it("refuses an answer to another question", () => {
    const bytes = new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures/doh-example-com-a.bin")));
    expect(() => readDohAnswer(bytes, "example.org", 1)).toThrow();
    expect(() => readDohAnswer(bytes, "example.com", 28)).toThrow();
    expect(() => readDohAnswer(encodeQuery("example.com", 1), "example.com", 1)).toThrow("not a response");
  });

  it("takes a name out of what a person types", () => {
    expect(domainOf("Example.COM")).toBe("example.com");
    expect(domainOf(" https://www.example.com/path?q=1 ")).toBe("www.example.com");
    expect(domainOf("example.com.")).toBe("example.com");
    expect(domainOf("bücher.example")).toBe("xn--bcher-kva.example");
    expect(domainOf("_dmarc.example.com")).toBe("_dmarc.example.com");
    for (const bad of ["", "localhost", "192.0.2.1", "exa mple.com", "user@example.com", "example.com:8080", "-a.example.com", "a..example.com"]) {
      expect(domainOf(bad), bad).toBeNull();
    }
  });
});
