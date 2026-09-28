// Forensics/reverse/pwn need to look at raw bytes constantly — read_file assumes UTF-8 text and
// mangles anything else. These read the same file as actual bytes.

const MAX_BINARY_READ_BYTES = 8 * 1024 * 1024;
const HEXDUMP_DEFAULT_LENGTH = 512;
const HEXDUMP_MAX_LENGTH = 8_192;
const STRINGS_MAX_RESULTS = 2_000;

const MAGIC_SIGNATURES: { bytes: number[]; type: string }[] = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], type: 'PNG image' },
  { bytes: [0xff, 0xd8, 0xff], type: 'JPEG image' },
  { bytes: [0x47, 0x49, 0x46, 0x38], type: 'GIF image' },
  { bytes: [0x25, 0x50, 0x44, 0x46], type: 'PDF document' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], type: 'ZIP archive (or ZIP-based: docx/xlsx/jar/apk...)' },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], type: 'ELF binary' },
  { bytes: [0x4d, 0x5a], type: 'PE/DOS executable (.exe/.dll)' },
  { bytes: [0x52, 0x61, 0x72, 0x21], type: 'RAR archive' },
  { bytes: [0x1f, 0x8b], type: 'GZIP' },
  { bytes: [0x42, 0x5a, 0x68], type: 'BZIP2' },
  { bytes: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], type: 'MP4/ISO media' },
  { bytes: [0x49, 0x44, 0x33], type: 'MP3 (ID3)' },
  { bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65], type: 'SQLite database' },
];

function detectMagic(buffer: Buffer): string {
  for (const sig of MAGIC_SIGNATURES) {
    if (buffer.length >= sig.bytes.length && sig.bytes.every((b, i) => buffer[i] === b)) return sig.type;
  }
  return 'unknown (no recognized magic bytes)';
}

export function hexdump(buffer: Buffer, offset: number, length: number): string {
  const start = Math.max(0, offset);
  const end = Math.min(buffer.length, start + length);
  const lines: string[] = [];
  for (let i = start; i < end; i += 16) {
    const chunk = buffer.subarray(i, Math.min(i + 16, end));
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
  }
  return lines.join('\n');
}

export function extractStrings(buffer: Buffer, minLength: number): string[] {
  const results: string[] = [];
  let current: number[] = [];
  const flush = () => {
    if (current.length >= minLength) results.push(String.fromCharCode(...current));
    current = [];
  };
  for (const byte of buffer) {
    if (byte >= 0x20 && byte < 0x7f) {
      current.push(byte);
    } else {
      flush();
    }
    if (results.length >= STRINGS_MAX_RESULTS) break;
  }
  flush();
  return results;
}

export function fileInfoSummary(buffer: Buffer, totalBytes: number): string {
  const magic = detectMagic(buffer);
  const headHex = [...buffer.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return [
    `Size: ${totalBytes} bytes`,
    `Detected type: ${magic}`,
    `First 16 bytes: ${headHex}`,
  ].join('\n');
}

export { MAX_BINARY_READ_BYTES, HEXDUMP_DEFAULT_LENGTH, HEXDUMP_MAX_LENGTH };
