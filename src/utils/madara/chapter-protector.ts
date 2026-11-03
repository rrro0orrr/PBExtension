// Madara "chapter protector" support.
//
// Many Madara sources serve real (image) manga pages behind an AES-encrypted
// blob rather than inline `<img>` tags. The encrypted payload lives in a
// `<script id="chapter-protector-data">` element using the CryptoJS "Salted__"
// passphrase format, with the passphrase exposed as `wpmangaprotectornonce`.
//
// This mirrors the upstream keiyoushi `Madara.pageListParse` + `CryptoAES`
// logic: reconstruct the OpenSSL envelope, derive key/IV via EVP_BytesToKey
// (MD5, 1 iteration), AES-256-CBC/PKCS7 decrypt, then double-JSON-decode the
// result into an array of image URLs.

import { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

export const CHAPTER_PROTECTOR_SELECTOR = "#chapter-protector-data";
const PASSWORD_PREFIX = "wpmangaprotectornonce='";
const DATA_PREFIX = "chapter_data='";

// Returns the decrypted page URL array, or null when no protector element is
// present (caller should fall back to plain `<img>` scraping).
export async function decryptChapterProtector($: CheerioAPI): Promise<string[] | null> {
  const protector = $(CHAPTER_PROTECTOR_SELECTOR).first();
  if (protector.length === 0) return null;

  // The protector HTML may be inlined or delivered via a base64 data URI.
  const src = (protector as Cheerio<AnyNode>).attr("src") || "";
  let protectorHtml: string;
  const dataPrefix = "data:text/javascript;base64,";
  if (src.startsWith(dataPrefix)) {
    protectorHtml = utf8FromBytes(base64ToBytes(src.slice(dataPrefix.length)));
  } else {
    protectorHtml = protector.html() ?? "";
  }

  const password = substringBefore(substringAfter(protectorHtml, PASSWORD_PREFIX), "';");

  const chapterDataRaw = substringBefore(substringAfter(protectorHtml, DATA_PREFIX), "';").replace(
    /\\\//g,
    "/",
  );

  const chapterData = JSON.parse(chapterDataRaw) as {
    ct: string;
    s: string;
  };

  // Reconstruct the CryptoJS "Salted__" ciphertext:
  //   "Salted__" || salt (from hex `s`) || ciphertext (from base64 `ct`).
  const unsaltedCiphertext = base64ToBytes(chapterData.ct);
  const salt = hexToBytes(chapterData.s);

  const decryptedJson = await cryptoJsDecrypt(unsaltedCiphertext, salt, password);

  // The decrypted payload is a JSON string whose value is itself a JSON
  // array of image URLs (double-encoded upstream).
  const imgArrayString = JSON.parse(decryptedJson) as string;
  const imgArray = JSON.parse(imgArrayString) as string[];
  return imgArray;
}

// ----------------------------------------------------------------
// CryptoJS-compatible AES-256-CBC decryption (module-level helpers)
// ----------------------------------------------------------------

function substringAfter(value: string, delimiter: string): string {
  const idx = value.indexOf(delimiter);
  return idx === -1 ? value : value.slice(idx + delimiter.length);
}

function substringBefore(value: string, delimiter: string): string {
  const idx = value.indexOf(delimiter);
  return idx === -1 ? value : value.slice(0, idx);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const decoded = Application.base64Decode(b64.trim());
  if (typeof decoded === "string") {
    const out = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
    return out;
  }
  return new Uint8Array(decoded);
}

function utf8FromBytes(bytes: Uint8Array): string {
  return Application.arrayBufferToUTF8String(bufferOf(bytes));
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

// OpenSSL EVP_BytesToKey (MD5, 1 iteration) -> 32-byte key + 16-byte IV,
// then AES-256-CBC / PKCS7 decrypt via WebCrypto. Mirrors CryptoAES.decrypt.
async function cryptoJsDecrypt(
  ciphertext: Uint8Array,
  salt: Uint8Array,
  password: string,
): Promise<string> {
  const passwordBytes = utf8ToBytes(password);
  const { key, iv } = evpBytesToKey(passwordBytes, salt, 32, 16);

  const subtle = (globalThis as { crypto: { subtle: SubtleLike } }).crypto.subtle;
  const cryptoKey = await subtle.importKey("raw", bufferOf(key), { name: "AES-CBC" }, false, [
    "decrypt",
  ]);
  const plain = new Uint8Array(
    await subtle.decrypt({ name: "AES-CBC", iv: bufferOf(iv) }, cryptoKey, bufferOf(ciphertext)),
  );
  return utf8FromBytes(plain);
}

function utf8ToBytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function evpBytesToKey(
  password: Uint8Array,
  salt: Uint8Array,
  keyLen: number,
  ivLen: number,
): { key: Uint8Array; iv: Uint8Array } {
  const target = keyLen + ivLen;
  const generated: Uint8Array[] = [];
  let total = 0;
  let prev: Uint8Array = new Uint8Array(0);
  while (total < target) {
    const input = new Uint8Array(prev.length + password.length + salt.length);
    input.set(prev, 0);
    input.set(password, prev.length);
    input.set(salt, prev.length + password.length);
    prev = md5(input);
    generated.push(prev);
    total += prev.length;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const block of generated) {
    merged.set(block, offset);
    offset += block.length;
  }
  return {
    key: merged.slice(0, keyLen),
    iv: merged.slice(keyLen, keyLen + ivLen),
  };
}

// ----------------------------------------------------------------
// Minimal MD5 (RFC 1321), operating on bytes -> 16-byte digest.
// ----------------------------------------------------------------

function md5(input: Uint8Array): Uint8Array {
  const rotl = (x: number, c: number): number => (x << c) | (x >>> (32 - c));
  const add = (a: number, b: number): number => (a + b) | 0;

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];

  const msgLen = input.length;
  const bitLen = msgLen * 8;
  // padded length: multiple of 64, leaving 8 bytes for length.
  const paddedLen = (((msgLen + 8) >> 6) << 6) + 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(input, 0);
  padded[msgLen] = 0x80;
  // Append 64-bit little-endian bit length (low 32 bits, then high 32 bits).
  const lo = bitLen >>> 0;
  const hi = Math.floor(bitLen / 0x100000000) >>> 0;
  padded[paddedLen - 8] = lo & 0xff;
  padded[paddedLen - 7] = (lo >>> 8) & 0xff;
  padded[paddedLen - 6] = (lo >>> 16) & 0xff;
  padded[paddedLen - 5] = (lo >>> 24) & 0xff;
  padded[paddedLen - 4] = hi & 0xff;
  padded[paddedLen - 3] = (hi >>> 8) & 0xff;
  padded[paddedLen - 2] = (hi >>> 16) & 0xff;
  padded[paddedLen - 1] = (hi >>> 24) & 0xff;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Int32Array(16);
  for (let chunk = 0; chunk < paddedLen; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      const j = chunk + i * 4;
      M[i] = padded[j] | (padded[j + 1] << 8) | (padded[j + 2] << 16) | (padded[j + 3] << 24);
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = add(add(add(F, A), K[i]), M[g]);
      A = D;
      D = C;
      C = B;
      B = add(B, rotl(F, S[i]));
    }

    a0 = add(a0, A);
    b0 = add(b0, B);
    c0 = add(c0, C);
    d0 = add(d0, D);
  }

  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let i = 0; i < 4; i++) {
    out[i * 4] = words[i] & 0xff;
    out[i * 4 + 1] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (words[i] >>> 24) & 0xff;
  }
  return out;
}

// Minimal structural type for the WebCrypto subtle API used above.
interface SubtleLike {
  importKey(
    format: string,
    keyData: ArrayBuffer,
    algorithm: { name: string },
    extractable: boolean,
    keyUsages: string[],
  ): Promise<unknown>;
  decrypt(
    algorithm: { name: string; iv: ArrayBuffer },
    key: unknown,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer>;
}
