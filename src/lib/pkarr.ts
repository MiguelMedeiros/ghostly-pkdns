/** Reading a Pkarr public key out of what a person types or pastes. Ported from the extension's lib/pkarr.ts. */
import { PKARR_KEY_LENGTH, Z_BASE32_ALPHABET, decodePublicKey } from "./zbase32";

/** Prefixes used in the Pubky ecosystem. Longer first. */
const KNOWN_PREFIXES = ["pubky://", "pubky:", "pubky", "pk:"] as const;

/**
 * A valid key is 52 z-base32 characters that decode to 32 bytes. Unlike the extension, the spare bits must be zero
 * too: a text that passes here is always a key the signature check can use.
 */
export function isValidPkarrKey(input: string): boolean {
  return decodePublicKey(input.toLowerCase()) !== null;
}

export function normalizePkarrKey(key: string): string {
  return key.toLowerCase().trim();
}

export function stripPubkyPrefix(input: string): string {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  for (const prefix of KNOWN_PREFIXES) {
    if (lower.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}

/** The key in a text: a bare key, a prefixed one (`pk:`, `pubky`, `pubky://`), or the first 52-character token. */
export function extractPkarrKey(text: string): string | null {
  const trimmed = text.trim();
  if (isValidPkarrKey(trimmed)) return normalizePkarrKey(trimmed);
  const stripped = stripPubkyPrefix(trimmed).replace(/\/.*$/, "");
  if (isValidPkarrKey(stripped)) return normalizePkarrKey(stripped);
  const pattern = new RegExp(`(?<![${Z_BASE32_ALPHABET}])[${Z_BASE32_ALPHABET}]{${PKARR_KEY_LENGTH}}(?![${Z_BASE32_ALPHABET}])`, "gi");
  for (const match of trimmed.match(pattern) ?? []) {
    if (isValidPkarrKey(match)) return normalizePkarrKey(match);
  }
  return null;
}

/** "7fmjpcuuzf54hw18bsgi3zihzyh4awseeuq5tmojefaezjbd64cy" as "7fmjpcuu...bd64cy". */
export function truncateKey(key: string, startLen = 8, endLen = 6): string {
  if (key.length <= startLen + endLen + 3) return key;
  return `${key.slice(0, startLen)}...${key.slice(-endLen)}`;
}
