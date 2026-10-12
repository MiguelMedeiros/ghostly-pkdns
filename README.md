# PKDNS Resolver for Ghostly

Resolve [Pkarr](https://github.com/pubky/pkarr) public keys to DNS records, inside [Ghostly](https://github.com/MiguelMedeiros/ghostly).
A mini-app ([WISP 1200](https://github.com/MiguelMedeiros/ghostly/blob/dev/docs/wisps/1200-marketplace.md)) that opens
alone, full screen (`view: "full"`), with one permission, `internet`. It builds to one self-contained HTML file.

It is a port of the [PKDNS Resolver extension](https://github.com/pubky/pkdns-resolver-extension) (MIT), with one
thing the extension does not do: **every relay answer is verified in the app** before anything in it is shown.

## What it does

- **Resolver.** Paste a z-base32 key (52 characters), or a `pk:`, `pubky` or `pubky://` address. A valid key resolves
  by itself. It shows the public key, last updated, payload size, record count, the relay it was resolved via and
  how long it took, a "Cached" mark, and the DNS records (type, name, value, TTL). A list under it says what each
  relay answered.
- **Verification.** A relay's payload is a 64-byte Ed25519 signature, an 8-byte timestamp (microseconds, big-endian)
  and a DNS packet. The app checks the signature over the bytes Pkarr signs (`3:seqi<timestamp>e1:v<length>:<packet>`,
  the BEP 44 form) with the key that was asked for. A relay is never trusted:
  - a bad signature is refused;
  - a record older than the newest one already seen for that key is refused (the newest timestamp is kept per key, in
    storage, so this holds after the app is closed);
  - a record dated more than two hours ahead of the device's clock is refused;
  - a packet over Pkarr's 1000 bytes, an answer over 2 KiB, or a signed packet that does not read as DNS to its end
    is refused;
  - when relays disagree, the newest valid record wins, and the list marks the relay that is behind.
- **Visit Website / Visit Pubky Profile.** The app shows the address with a Copy button (see [Limits](#limits)).
- **Domain names.** Anything that is a domain name and not a key is looked up over DNS over HTTPS: A, AAAA, CNAME,
  TXT, HTTPS and SVCB, at Cloudflare, Google or Quad9 (chosen in Settings). The result names the resolver that
  answered. These answers are not signed, and the page says so.
- **Favorites** (label, edit, remove, search, sort; 50 at most) and **Recent** (search, remove, clear; 100 at most).
- **History & analytics.** Every resolve: date, key, relay, time, size. Totals and averages, response time and payload
  size over time, resolves per day, per-relay performance, a filter by key, CSV export, clear. The last 1000 resolves.
  Charts are plain SVG and HTML, drawn by the app.
- **Relays.** Defaults `pkarr.pubky.org`, `pkarr.pubky.app` and `pkarr.miguelmedeiros.dev`. Add, remove, enable and
  disable custom relays, reset to defaults, "n of m relays active". Test one or all: latency with min, average and
  max, a comparison and a history (the last 20 tests of each relay). Auto-refresh every 5 to 120 seconds while the
  Relays page is open.
- **Settings.** Request timeout, cache duration (off, or 1 to 30 minutes; 50 entries at most), Clear cache, the DNS
  over HTTPS resolver, export and import of everything, Clear all data, display language.
- **How it works**, and nine languages: Arabic (right to left), German, English, Spanish, French, Italian, Japanese,
  Brazilian Portuguese, Chinese. The language follows Ghostly's until one is chosen in Settings.
- Phone (375 px) and desktop layouts, every control reachable by keyboard, and the client's light or dark theme
  (`ghostly.context().theme`, asked again when the app comes back into view).

## Limits

What the extension does and a Ghostly app cannot, and what differs:

| | |
|---|---|
| No omnibox, no context menu | An app has no address bar keyword (`pk` + Tab) and no right-click entry. Paste the key into the app |
| No auto-redirect | An app cannot navigate anywhere, itself included: the runner's sandbox allows no navigation and no popup |
| Links are copied, not opened | The broker has no call to open a link outside the app, and the frame may not open a window. "Visit Website" and "Visit Pubky Profile" show the address with a Copy button |
| No site rendered in the app | The runner's policy allows no frame (`frame-src 'none'`) |
| Relays must be HTTPS | The network runner reaches `https:` and `wss:` only. A plain `http://` relay is refused when added, and left out of an imported backup |
| Export is text, not a file | A sandboxed frame cannot start a download. Export (the backup, and the history's CSV) shows the text with a Copy button. Import takes pasted text, or a file where the client lets a frame open the file picker |
| Copy | The Clipboard API is off in the frame (`allow=""`). The app falls back to the older copy command, which worked in Chromium when measured; where that is refused too, it shows the text to select |
| Paste button | Reading the clipboard is not allowed, so there is none: paste with the keyboard or the system menu |
| DNS over HTTPS answers are not verified | DNSSEC is not checked. The chosen resolver is believed, as any resolver is |
| The DHT is not asked directly | As in the extension: a browser has no UDP. Relays do it, which is why their answers are verified |

**DNS over HTTPS and CORS** (measured 2026-10-12, from an opaque origin, which is what a sandboxed app has). The query
goes as `GET <endpoint>?dns=<base64url>` (RFC 8484) with no header of the app's own, so the browser sends no
preflight. `cloudflare-dns.com/dns-query`, `dns.google/dns-query` and `dns.quad9.net/dns-query` all answer it with
`Access-Control-Allow-Origin: *`. Sending `Accept: application/dns-message` would make it a preflighted request, which
is why the app does not. The three Pkarr relays answer `GET /<key>` and `GET /` with the request's origin echoed in
`Access-Control-Allow-Origin` (`null` for the sandbox). A custom relay needs the same to be reachable.

One thing seen while measuring: `pkarr.miguelmedeiros.dev` sends `x-ratelimit-limit: 10`, and when a run of requests
went over it, its answers came without the CORS header. A browser hides such an answer from the app, so that relay
shows as "unreachable" (not as "rate limited") until the limit clears; the other relays still answer. Auto-refresh
at its shortest interval, together with resolves, can reach that limit.

## Storage

An app opened alone has storage: the broker's `ghostly.storage` (`get`, `set`, `delete`, `keys`), one scope for this
app, kept by Ghostly on the device: keys up to 256 bytes, JSON values up to 64 KiB, 5 MiB in all. The app keeps
`settings`, `favorites`, `recent`, `relays`, `seen` (the newest timestamp per key) and `latency` as one value each. The
history and the cache can pass 64 KiB, so they are written in pieces (`history.0`, `history.1`…, `cache.0`…), each
under 48 KiB. A full history is about 150 KiB; everything together stays far under 5 MiB. A refused write (`full`)
shows a message and loses nothing in memory.

Uninstalling the app removes its storage (Ghostly offers an export first). The app's own Export in Settings gives
everything but the cache as JSON, in the extension's backup format with this app's fields beside it, so a backup made
by the extension imports here. A backup is cleaned field by field as it comes in.

Opened outside Ghostly (no broker: `npm run dev`, or the HTML file by itself) the app runs with its data in memory
only, and Settings says so.

## Build and test

Node 22 or later.

```sh
npm ci
npm test          # vitest: 90 tests
npm run build     # typecheck, then dist/index.html, the whole app in one file
npm run digest    # the file's size and SHA-256, as a signed bundle lists it
npm run dev       # the app in a browser, without Ghostly (data in memory)
```

The tests (`test/`):

| File | What it checks |
|---|---|
| `payload.test.ts` | The payload check: a good packet and a real recorded one accepted; a changed signature, record or timestamp, another key's signature, an older timestamp, a future one, a truncated payload, a truncated or lying signed packet and an oversized one refused |
| `dnswire.test.ts` | DNS packet parsing: every record type shown, compression pointers, loops, a packet cut at every length, IPv6 text, DNS over HTTPS queries and a real recorded answer |
| `resolver.test.ts` | Asking relays: the newest valid record wins, a forged answer loses, timeouts, relay tests, a DNS over HTTPS lookup |
| `data.test.ts` | Limits (50, 100, 1000, 20), relay rules, relay latency min/avg/max, history figures, the CSV, the export/import round trip, hostile backups, the stored pieces |
| `ui.test.ts` | The app in a DOM with a made-up broker and relays: resolving, a forged or replayed answer never shown, record text never run as markup, favorites, recent, history, relays, settings, languages, dialogs |
| `bundle.test.ts` | The build is one HTML file that names no server but the relays and resolvers; the manifest; all nine languages complete |

The payload tests were written first and run against a port of the extension's parser, which checks nothing: 11 of
13 failed (everything but the two "accepted" cases). The check was then written until all 13 passed.

`npm run shots` builds the app and takes screenshots of it with Playwright (Chromium), resolving a real key from the
real relays. It runs the build as Ghostly's web client does: in `<iframe sandbox="allow-scripts" allow="">` of the
real runner page (`test/browser/app-frame.html`, copied unchanged from the Ghostly repository) served with the
network runner's Content-Security-Policy header. The client around the runner is a stand-in
(`test/browser/harness.mjs`): it does the broker's part (the port, `start`, `writing`, `context`, `storage`) with the
storage in the page's memory. `npm run shots -- --tour <folder>` also walks every page, in light theme and in Arabic.
`npm run shots -- --phone` also takes `phone-more.png` and `phone-<page>.png`, and checks the phone's bottom bar in the
nine languages at 375 and 320 px (five places, none cut, no page wider than the screen, the last row above the bar).
`node test/browser/harness.mjs` serves the same host on `http://127.0.0.1:4173/` to try the app by hand.

## Sign and publish

Signing is the publisher's: only the holder of the app's publisher key can sign a version Ghostly will install or
update to. Nothing in this repository holds a key, and no bundle is signed by the build.

```sh
npm ci && npm test && npm run build
npm run digest        # note the SHA-256
npm run stage         # release/index.html + release/ghostly-app.json: the folder to sign
ghostly app publish release --key <the publisher key file> --out app.ghostlyapp --pretty
ghostly app verify app.ghostlyapp --pretty
```

`ghostly app publish` takes every file in the folder it is given, so it is run on `release/`, never on the
repository. It writes `publisher`, `sequence` and `files` into the manifest; `ghostly-app.json` here has none of
them. The signed `app.ghostlyapp` is committed at the repository's root, where the manifest's `sources` points
(`.gitignore` lets that one bundle in, and no key). To add `icon.png` (square, at most 256 KiB) or screenshots, put
them in `release/` before signing.

## Layout

| Path | What it is |
|---|---|
| `src/lib/payload.ts` | The payload check |
| `src/lib/dnswire.ts`, `records.ts` | DNS packets, read without a library; records as the table shows them |
| `src/lib/resolver.ts`, `doh.ts` | Asking relays; DNS over HTTPS |
| `src/lib/model.ts`, `store.ts`, `backup.ts`, `stats.ts` | The data and its limits, storage, export/import, the figures and the CSV |
| `src/lib/i18n.ts`, `src/locales/` | The extension's locale files, and this app's own texts over them (`extra/`) |
| `src/ui/` | The pages (`views.ts`), the charts (`charts.ts`) and the app (`app.ts`) |
| `src/vendor/miniApp.ts` | The broker's types and limits, vendored from Ghostly (`@ghostlytools/sdk/app`) |
| `ghostly-app.json` | The manifest, without what the publisher CLI writes |
| `vite.config.ts` | The single-file build, with the license notices of what the file carries |

## Credits and license

[MIT](LICENSE). Ported from the PKDNS Resolver extension, Copyright (c) 2025 Pubky, MIT
(`assets/LICENSE-pkdns-resolver-extension`): its locale files, record formatting and page structure. Signatures are
verified with [@noble/curves](https://github.com/paulmillr/noble-curves) (MIT). Icons from
[Heroicons](https://heroicons.com) (MIT). The built file carries all three notices.
