// Screenshots of the built app, running in the real runner page under the network runner's policy, inside the test
// host of test/browser/harness.mjs (which stands in for the Ghostly client: see what it stubs there).
//
//   npm run shots                         phone.png (375x812) and desktop.png (1280x800) in ../shots
//   npm run shots -- --out <folder>       somewhere else
//   npm run shots -- --fixture            never the network: relays answer with test/fixtures/pkarr-7fmjpcuu.bin
//   npm run shots -- --phone              also phone-more.png and phone-<page>.png, and the bar checked in every language
//   npm run shots -- --tour <folder>     also every page, light theme and Arabic, into <folder> (for a look by eye)
//
// Resolves go to the real relays. When none answers within the time allowed, the run is done again with the recorded
// answer, and the script says so.
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../test/browser/harness.mjs";

const KEY = "7fmjpcuuzf54hw18bsgi3zihzyh4awseeuq5tmojefaezjbd64cy";
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = resolve(option("--out") ?? new URL("../../shots", import.meta.url).pathname);
const tour = option("--tour") ? resolve(option("--tour")) : null;
const recorded = readFileSync(new URL("../test/fixtures/pkarr-7fmjpcuu.bin", import.meta.url));

const { server, url } = await startServer();
const browser = await chromium.launch();
const problems = [];

/** A page of the given size with the app in it, and the app's frame. */
async function open(width, height, { theme = "dark", locale = "en", fixture = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (message) => {
    const text = message.text();
    // Two refusals are the sandbox working: the runner's own probe frame, whose script must not run (the nonce lock),
    // and the Clipboard API, which the frame's empty `allow` turns off (the app then falls back).
    if (/script-src 'nonce-/.test(text) || /Clipboard API has been blocked/.test(text)) return;
    if (message.type() === "error") problems.push(`${width}px console: ${text}`);
  });
  page.on("pageerror", (error) => problems.push(`${width}px error: ${error.message}`));
  if (fixture) {
    await page.route(/^https:\/\/pkarr\./, (route) =>
      new URL(route.request().url()).pathname.length > 1
        ? route.fulfill({ status: 200, body: recorded, headers: { "access-control-allow-origin": "*", "content-type": "application/pkarr.org/relays#payload" } })
        : route.fulfill({ status: 200, body: "", headers: { "access-control-allow-origin": "*" } }),
    );
  }
  await page.goto(`${url}/?theme=${theme}&locale=${locale}`);
  const frame = page.frameLocator("iframe");
  await frame.locator("#query").waitFor({ timeout: 15_000 });
  return { context, page, frame };
}

async function resolveKey(frame, timeout) {
  await frame.locator("#query").fill(KEY);
  await frame.locator(".result").waitFor({ timeout });
}

async function shoot(width, height, name, fixture) {
  const { context, page, frame } = await open(width, height, { fixture });
  await resolveKey(frame, fixture ? 10_000 : 25_000);
  await page.screenshot({ path: resolve(out, name) });
  await context.close();
}

mkdirSync(out, { recursive: true });
let fixture = args.includes("--fixture");
try {
  await shoot(375, 812, "phone.png", fixture);
} catch (error) {
  if (fixture) throw error;
  console.log(`no relay answered (${String(error).split("\n")[0]}): using the recorded answer instead`);
  fixture = true;
  await shoot(375, 812, "phone.png", true);
}
await shoot(1280, 800, "desktop.png", fixture);
console.log(`${out}/phone.png and desktop.png, resolved ${fixture ? "from the recorded fixture" : "from the real relays"}`);

/** A page, by the phone's bar: its own place, or the one in the "More" sheet. */
async function phoneGo(frame, view) {
  if (await frame.locator(`.dock-item[data-arg="${view}"]`).count()) await frame.locator(`.dock-item[data-arg="${view}"]`).click();
  else {
    await frame.locator('.dock-item[data-action="more"]').click();
    await frame.locator(`.sheet-item[data-arg="${view}"]`).click();
  }
  await frame.locator("main h1").waitFor();
  // A phone has no pointer left resting on the page.
  await frame.locator("body").page().mouse.move(0, 0).catch(() => {});
}

/** What is cut or covered at a phone's width: a page wider than the screen, a bar label wider than its place, a last row under the bar. */
const phoneFaults = (frame) =>
  frame.locator("body").evaluate(() => {
    const faults = [];
    const wide = document.documentElement.scrollWidth - window.innerWidth;
    if (wide > 0) faults.push(`the page is ${wide}px wider than the screen`);
    const items = [...document.querySelectorAll(".dock-item")];
    if (items.length !== 5) faults.push(`${items.length} places in the bar`);
    for (const item of items) {
      const box = item.getBoundingClientRect();
      const label = item.querySelector(".dock-label").getBoundingClientRect();
      if (box.height < 44) faults.push(`"${item.textContent}" is ${box.height}px tall`);
      if (label.left < box.left || label.right > box.right) faults.push(`"${item.textContent}" is wider than its place (${Math.round(label.width)} in ${Math.round(box.width)})`);
    }
    const bar = document.querySelector(".dock").getBoundingClientRect();
    if (Math.round(bar.bottom) !== window.innerHeight || bar.left !== 0 || Math.round(bar.right) !== window.innerWidth) faults.push(`the bar is not along the bottom (${bar.left} to ${bar.right}, down to ${bar.bottom}, in ${window.innerWidth}x${window.innerHeight})`);
    if (document.querySelector(".tabs").getClientRects().length) faults.push("the tabs still show");
    window.scrollTo(0, document.body.scrollHeight);
    const last = [...document.querySelectorAll("main > *")].pop().getBoundingClientRect();
    if (last.bottom > bar.top) faults.push(`the last row ends ${Math.round(last.bottom - bar.top)}px under the bar`);
    window.scrollTo(0, 0);
    return faults;
  });

if (args.includes("--phone")) {
  // Every page at a phone's width, with the sheet open once, then the bar in every language at 375 and 320 px.
  const { context, page, frame } = await open(375, 812, { fixture });
  await resolveKey(frame, 25_000);
  await frame.locator('[data-action="favorite"]').click();
  await frame.locator("#dialog-input").fill("Demo key");
  await frame.locator('[data-dialog="save"]').click();
  await frame.locator(".toast").waitFor({ state: "detached" });
  await frame.locator('.dock-item[data-action="more"]').click();
  await frame.locator(".sheet").waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, "phone-more.png") });
  await page.keyboard.press("Escape");
  for (const view of ["favorites", "recent", "relays", "history", "settings", "how"]) {
    await phoneGo(frame, view);
    if (view === "relays") {
      await frame.locator('[data-action="test-all"]').click();
      await frame.locator(".ping.online, .ping.offline").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(2500);
    }
    for (const fault of await phoneFaults(frame)) problems.push(`phone ${view}: ${fault}`);
    await page.screenshot({ path: resolve(out, `phone-${view}.png`) });
    await frame.locator("body").evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.screenshot({ path: resolve(out, `phone-${view}-end.png`) });
  }
  await context.close();
  for (const locale of ["en", "pt-BR", "es", "de", "fr", "it", "zh", "ja", "ar"]) {
    for (const width of [375, 320]) {
      const phone = await open(width, 700, { locale, fixture: true });
      for (const view of ["resolver", "favorites", "recent", "relays", "history", "settings", "how"]) {
        if (view !== "resolver") await phoneGo(phone.frame, view);
        for (const fault of await phoneFaults(phone.frame)) problems.push(`${locale} ${width}px ${view}: ${fault}`);
      }
      if (width === 375 && ["de", "fr", "pt-BR", "ar"].includes(locale)) {
        await phone.frame.locator('.dock-item[data-action="more"]').click();
        await phone.page.waitForTimeout(300);
        await phone.page.screenshot({ path: resolve(out, `phone-more-${locale}.png`) });
      }
      await phone.context.close();
    }
  }
  console.log(`${out}/phone-more.png and phone-<page>.png; the bar checked in 9 languages at 375 and 320 px`);
}

if (tour) {
  mkdirSync(tour, { recursive: true });
  for (const [width, height, tag, options] of [[375, 812, "phone", {}], [1280, 800, "desktop", {}], [375, 812, "phone-light-ar", { theme: "light", locale: "ar" }], [1280, 800, "desktop-light", { theme: "light" }]]) {
    const { context, page, frame } = await open(width, height, { ...options, fixture });
    const snap = (name) => page.screenshot({ path: resolve(tour, `${tag}-${name}.png`), fullPage: false });
    const go = async (view) => {
      if (width <= 480) return phoneGo(frame, view);
      await frame.locator(`.tab[data-arg="${view}"]`).click();
      await frame.locator("main h1").waitFor();
    };
    await snap("start");
    await resolveKey(frame, 25_000);
    await frame.locator('[data-action="refresh"]').click();
    await frame.locator(".result").waitFor({ timeout: 25_000 });
    await frame.locator('[data-action="favorite"]').click();
    await frame.locator("#dialog-input").fill("Demo key");
    await snap("dialog");
    await frame.locator('[data-dialog="save"]').click();
    await snap("resolved");
    await frame.locator("#query").fill("example.com");
    await frame.locator("#query").press("Enter");
    await frame.locator(".result").waitFor({ timeout: 25_000 }).catch(() => problems.push(`${tag}: no DoH answer`));
    await snap("dns");
    for (const view of ["favorites", "recent", "history", "relays", "settings", "how"]) {
      await go(view);
      if (view === "relays") {
        await frame.locator('[data-action="test-all"]').click();
        await frame.locator(".ping.online, .ping.offline").first().waitFor({ timeout: 15_000 });
        await page.waitForTimeout(1500);
        await frame.locator('[data-action="test-all"]').click();
        await page.waitForTimeout(2500);
      }
      await snap(view);
      if (view === "history" || view === "relays") {
        await page.evaluate(() => 0);
        await frame.locator("main").evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await snap(`${view}-end`);
      }
    }
    // Copying: the key's button on the resolver, and whether the app could copy or had to show the text.
    await go("resolver");
    await frame.locator('.facts [data-action="copy"]').first().click();
    await page.waitForTimeout(300);
    const copied = (await frame.locator(".dialog").count()) ? "shown to copy by hand" : `toast: ${await frame.locator(".toast").textContent().catch(() => "none")}`;
    if (await frame.locator(".dialog").count()) await frame.locator('[data-dialog="cancel"]').last().click();
    await frame.locator('[data-action="open-link"]').first().click();
    await snap("link");
    await frame.locator('[data-dialog="cancel"]').last().click();
    console.log(tag, "copy:", copied);
    // What the sandbox allows of the things the app tries.
    const facts = await frame.locator("body").evaluate(async () => {
      const clipboard = await navigator.clipboard.writeText("x").then(() => "allowed", (e) => `refused (${e.name})`);
      return { clipboard, origin: self.origin, overflow: document.documentElement.scrollWidth > window.innerWidth };
    });
    const host = await page.evaluate(() => ({ loads: window.__loads, stopped: window.__stopped ?? null, keys: [...window.__store.keys()], requests: window.__requests.length }));
    console.log(tag, JSON.stringify({ ...facts, ...host }));
    if (facts.overflow) problems.push(`${tag}: the page is wider than the screen`);
    if (host.stopped) problems.push(`${tag}: the app was stopped (${host.stopped})`);
    await context.close();
  }
}

await browser.close();
server.close();
if (problems.length) {
  console.log(`problems:\n  ${[...new Set(problems)].join("\n  ")}`);
  process.exitCode = 1;
}
