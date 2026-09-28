import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';

// Long tool output (nmap XML, subdomain lists, big HTTP responses, command dumps) costs real
// money every time it gets resent on a later agent cycle. Today's answer to "too big" was to
// truncate it out of context and throw the rest away for good (see boundToolResult in
// deepseek.ts). An artifact is the same idea but recoverable: the full content is written to a
// file once, and the agent gets back a short handle (id + size + preview) instead of the whole
// blob — then it can page through the real thing later with read_artifact instead of the model
// (or the user) losing that data permanently.

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_ARTIFACTS_PER_PROJECT = 200;
const DEFAULT_READ_CHARS = 8_000;
const MAX_READ_CHARS = 20_000;
const PREVIEW_CHARS = 400;

export interface ArtifactMeta {
  id: string;
  bytes: number;
  createdAt: string;
  source: 'manual' | 'auto-truncation';
  preview: string;
}

interface ArtifactIndex {
  entries: ArtifactMeta[];
}

function artifactsDirFor(projectRoot: string): string {
  const key = crypto.createHash('sha1').update(projectRoot).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'artifacts', key);
}

function sanitizeId(name: string): string {
  const trimmed = name.trim().slice(0, 120);
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!safe) throw new Error('Artifact name must contain at least one letter, digit, dot, dash or underscore.');
  return safe;
}

async function readIndex(dir: string): Promise<ArtifactIndex> {
  try {
    const raw = await fs.readFile(path.join(dir, '_index.json'), 'utf8');
    const parsed = JSON.parse(raw) as ArtifactIndex;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

async function writeIndex(dir: string, index: ArtifactIndex): Promise<void> {
  await fs.writeFile(path.join(dir, '_index.json'), JSON.stringify(index, null, 2), 'utf8');
}

function makePreview(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > PREVIEW_CHARS ? `${collapsed.slice(0, PREVIEW_CHARS)}…` : collapsed;
}

export async function saveArtifact(
  projectRoot: string,
  name: string,
  content: string,
  source: ArtifactMeta['source'] = 'manual',
): Promise<ArtifactMeta> {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact content is ${(bytes / (1024 * 1024)).toFixed(1)} MB, over the ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MB cap.`);
  }
  const id = sanitizeId(name);
  const dir = artifactsDirFor(projectRoot);
  await fs.mkdir(dir, { recursive: true });

  const index = await readIndex(dir);
  const existingIndex = index.entries.findIndex((entry) => entry.id === id);
  const meta: ArtifactMeta = { id, bytes, createdAt: new Date().toISOString(), source, preview: makePreview(content) };
  if (existingIndex >= 0) index.entries[existingIndex] = meta;
  else index.entries.push(meta);

  if (index.entries.length > MAX_ARTIFACTS_PER_PROJECT) {
    // Drop the oldest entries past the cap; their files are cleaned up best-effort.
    const overflow = index.entries
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, index.entries.length - MAX_ARTIFACTS_PER_PROJECT);
    for (const stale of overflow) {
      index.entries = index.entries.filter((entry) => entry.id !== stale.id);
      await fs.unlink(path.join(dir, `${stale.id}.txt`)).catch(() => {});
    }
  }

  await fs.writeFile(path.join(dir, `${id}.txt`), content, 'utf8');
  await writeIndex(dir, index);
  return meta;
}

export async function readArtifact(
  projectRoot: string,
  name: string,
  offsetArg?: unknown,
  lengthArg?: unknown,
): Promise<string> {
  const id = sanitizeId(name);
  const dir = artifactsDirFor(projectRoot);
  const filePath = path.join(dir, `${id}.txt`);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    throw new Error(`No artifact named "${id}" (call artifact action=list to see what is saved).`);
  }

  const offset = typeof offsetArg === 'number' && Number.isFinite(offsetArg) ? Math.max(0, Math.round(offsetArg)) : 0;
  const requested = typeof lengthArg === 'number' && Number.isFinite(lengthArg) ? Math.round(lengthArg) : DEFAULT_READ_CHARS;
  const length = Math.min(MAX_READ_CHARS, Math.max(1, requested));

  if (offset >= content.length) {
    return `Artifact "${id}" is ${content.length} characters; offset ${offset} is past the end.`;
  }
  const slice = content.slice(offset, offset + length);
  const end = offset + slice.length;
  const header = `Artifact "${id}" — showing characters ${offset}-${end} of ${content.length}.`;
  const footer = end < content.length
    ? `\n\n[${content.length - end} more characters — call artifact action=read again with offset=${end} to continue.]`
    : '';
  return `${header}\n\n${slice}${footer}`;
}

export async function listArtifacts(projectRoot: string): Promise<string> {
  const dir = artifactsDirFor(projectRoot);
  const index = await readIndex(dir);
  if (index.entries.length === 0) return 'No artifacts saved for this project yet.';
  return index.entries
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((entry) => `${entry.id}  ${(entry.bytes / 1024).toFixed(1)}KB  ${entry.source}  ${entry.createdAt}\n  ${entry.preview}`)
    .join('\n');
}
