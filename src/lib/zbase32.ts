/** z-base32, the encoding of Pkarr public keys: 32 bytes are 52 characters. */

export const Z_BASE32_ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769";

/** Length of a z-base32 encoded Ed25519 public key. */
export const PKARR_KEY_LENGTH = 52;

export function zbase32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += Z_BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += Z_BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The bytes of a z-base32 text, or null when a character is not in the alphabet or the spare bits are not zero. */
export function zbase32Decode(text: string): Uint8Array | null {
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of text) {
    const index = Z_BASE32_ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out[at++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return value === 0 ? out : null;
}

/** The 32 bytes of a Pkarr public key, or null when the text is not one (52 characters that encode back the same). */
export function decodePublicKey(key: string): Uint8Array | null {
  if (key.length !== PKARR_KEY_LENGTH) return null;
  const bytes = zbase32Decode(key);
  return bytes && bytes.length === 32 ? bytes : null;
}
