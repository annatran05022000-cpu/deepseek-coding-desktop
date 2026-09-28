// Pure text transforms for CTF misc/crypto work — instant, no shell roundtrip (spawning
// `python3 -c "..."` or `echo | base64` every time is slow and costs an extra agent cycle).

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Buffer): string {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    out += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  while (out.length % 8 !== 0) out += '=';
  return out;
}

function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = '';
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: "${char}"`);
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

const MORSE_MAP: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..',
  J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
  S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....',
  '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.',
  '(': '-.--.', ')': '-.--.-', '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-',
  '+': '.-.-.', '-': '-....-', '_': '..--.-', '"': '.-..-.', '$': '...-..-', '@': '.--.-.',
};
const MORSE_REVERSE: Record<string, string> = Object.fromEntries(Object.entries(MORSE_MAP).map(([k, v]) => [v, k]));

function morseEncode(text: string): string {
  return text
    .toUpperCase()
    .split(/(\s+)/)
    .map((token) => {
      if (/^\s+$/.test(token)) return '/';
      return [...token].map((char) => MORSE_MAP[char] ?? `[?${char}]`).join(' ');
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function morseDecode(text: string): string {
  return text
    .trim()
    .split(/\s*\/\s*/)
    .map((word) =>
      word
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((code) => MORSE_REVERSE[code] ?? `[?${code}]`)
        .join(''),
    )
    .join(' ');
}

function binaryEncode(bytes: Buffer): string {
  return [...bytes].map((byte) => byte.toString(2).padStart(8, '0')).join(' ');
}

function binaryDecode(text: string): Buffer {
  const groups = text.trim().split(/\s+/).filter(Boolean);
  const bytes = groups.map((group) => {
    if (!/^[01]{1,8}$/.test(group)) throw new Error(`Invalid binary byte: "${group}" (expected up to 8 bits of 0/1).`);
    return parseInt(group, 2);
  });
  return Buffer.from(bytes);
}

export type CodecFormat = 'base64' | 'base32' | 'hex' | 'url' | 'rot13' | 'morse' | 'binary';
export type CodecOperation = 'encode' | 'decode';

export function runCodec(operation: CodecOperation, format: CodecFormat, text: string): string {
  switch (format) {
    case 'base64':
      return operation === 'encode'
        ? Buffer.from(text, 'utf8').toString('base64')
        : Buffer.from(text.trim(), 'base64').toString('utf8');
    case 'base32':
      return operation === 'encode'
        ? base32Encode(Buffer.from(text, 'utf8'))
        : base32Decode(text).toString('utf8');
    case 'hex':
      return operation === 'encode'
        ? Buffer.from(text, 'utf8').toString('hex')
        : Buffer.from(text.replace(/[^0-9a-fA-F]/g, ''), 'hex').toString('utf8');
    case 'url':
      return operation === 'encode' ? encodeURIComponent(text) : decodeURIComponent(text);
    case 'rot13':
      // Self-inverse: rotating twice returns the original, so "encode" and "decode" do the same thing.
      return text.replace(/[a-zA-Z]/g, (char) => {
        const base = char <= 'Z' ? 65 : 97;
        return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
      });
    case 'morse':
      return operation === 'encode' ? morseEncode(text) : morseDecode(text);
    case 'binary':
      return operation === 'encode'
        ? binaryEncode(Buffer.from(text, 'utf8'))
        : binaryDecode(text).toString('utf8');
    default:
      throw new Error(`Unknown codec format: ${format as string}`);
  }
}
