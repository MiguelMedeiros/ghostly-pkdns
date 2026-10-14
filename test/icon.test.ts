// The icon: drawn by scripts/icon.mjs, committed as assets/icon.png, and within WISP 1200's bounds for `icon.png`
// (a PNG whose header says it is square and at most 1024 pixels a side, at most 256 KiB).
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ICON, pixels, SIZE } from "../scripts/icon.mjs";

/** A PNG's IDAT chunks, joined and inflated: its scanlines. */
function scanlines(png: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") parts.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return inflateSync(Buffer.concat(parts));
}

describe("the icon", () => {
  // The pixels, not the PNG's bytes: another zlib may pack the same picture differently.
  it("is the script's drawing, pixel for pixel (run npm run gen:icon after changing it)", () => {
    expect(scanlines(readFileSync(ICON)).equals(pixels())).toBe(true);
  });

  it("is a square PNG within the bounds a client takes", () => {
    const png = readFileSync(ICON);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBe(SIZE);
    expect(width).toBeLessThanOrEqual(1024);
    expect(png.length).toBeLessThanOrEqual(256 * 1024);
  });
});
