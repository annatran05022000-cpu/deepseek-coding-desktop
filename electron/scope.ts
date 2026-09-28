import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';

// Per Lục Trầm's own framing: this is a legal rail, not a feature — a tool that lets an agent hit
// any host it wants has no business doing bounty/pentest work without a hard stop at "target not
// authorized." Scope is opt-in per project: an EMPTY list means unrestricted (matches today's
// behavior for projects that never set one), so this never silently blocks existing workflows.

interface ScopeStore {
  entries: string[]; // "example.com" | "*.example.com" | "10.0.0.5" | "10.0.0.0/24"
}

function scopeFileFor(projectRoot: string): string {
  const key = crypto.createHash('sha1').update(projectRoot).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'scope', `${key}.json`);
}

async function readScope(projectRoot: string): Promise<ScopeStore> {
  try {
    const raw = await fs.readFile(scopeFileFor(projectRoot), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ScopeStore>;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

async function writeScope(projectRoot: string, store: ScopeStore): Promise<void> {
  const file = scopeFileFor(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(store, null, 2), 'utf8');
}

function normalizeEntry(input: string): string {
  const withoutProtocol = input.trim().toLowerCase().replace(/^https?:\/\//, '');
  // CIDR (e.g. "10.0.0.0/24") uses "/" as part of the value itself, not a URL path separator —
  // only strip a trailing path for non-CIDR entries (a domain/IP pasted as part of a full URL).
  const isCidr = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(withoutProtocol);
  const trimmed = isCidr ? withoutProtocol : withoutProtocol.replace(/\/.*$/, '');
  if (!trimmed) throw new Error('Scope entry cannot be empty.');
  return trimmed;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

function matchesEntry(hostname: string, entry: string): boolean {
  const host = hostname.toLowerCase();

  // CIDR, e.g. 10.0.0.0/24
  if (entry.includes('/')) {
    const [base, bits] = entry.split('/');
    const baseInt = ipv4ToInt(base);
    const hostInt = ipv4ToInt(host);
    const prefix = Number(bits);
    if (baseInt === null || hostInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (baseInt & mask) === (hostInt & mask);
  }

  // Wildcard subdomain, e.g. *.example.com
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(1); // ".example.com"
    return host === entry.slice(2) || host.endsWith(suffix);
  }

  // Exact domain or IP
  return host === entry;
}

/** Empty scope = unrestricted. Non-empty scope = hostname must match at least one entry. */
export async function isInScope(projectRoot: string, hostname: string): Promise<boolean> {
  const { entries } = await readScope(projectRoot);
  if (entries.length === 0) return true;
  return entries.some((entry) => matchesEntry(hostname, entry));
}

/** Throws a clear, agent-readable error if scope is set and hostname is not in it. No-op otherwise. */
export async function enforceScope(projectRoot: string, hostname: string, toolName: string): Promise<void> {
  const inScope = await isInScope(projectRoot, hostname);
  if (!inScope) {
    throw new Error(
      `OUT OF SCOPE: "${hostname}" is not in this project's authorized scope list. ${toolName} refused. Use scope action=add if this target is actually authorized, or scope action=list to see what is allowed.`,
    );
  }
}

export async function addScopeEntry(projectRoot: string, input: string): Promise<string> {
  const entry = normalizeEntry(input);
  const store = await readScope(projectRoot);
  if (store.entries.includes(entry)) return `"${entry}" is already in scope for this project.`;
  store.entries.push(entry);
  await writeScope(projectRoot, store);
  return `Added "${entry}" to scope. Scope is now enforced for this project (${store.entries.length} entr${store.entries.length === 1 ? 'y' : 'ies'}) — http_request and recon will refuse any host that doesn't match.`;
}

export async function removeScopeEntry(projectRoot: string, input: string): Promise<string> {
  const entry = normalizeEntry(input);
  const store = await readScope(projectRoot);
  const next = store.entries.filter((existing) => existing !== entry);
  if (next.length === store.entries.length) throw new Error(`"${entry}" is not in this project's scope list.`);
  await writeScope(projectRoot, { entries: next });
  return next.length === 0
    ? `Removed "${entry}". Scope list is now empty — this project is UNRESTRICTED again (no scope enforcement).`
    : `Removed "${entry}" from scope (${next.length} entr${next.length === 1 ? 'y' : 'ies'} remaining).`;
}

export async function listScope(projectRoot: string): Promise<string> {
  const { entries } = await readScope(projectRoot);
  if (entries.length === 0) return 'No scope set for this project — UNRESTRICTED (http_request/recon accept any host). Use scope action=add to lock it down.';
  return [`Scope for this project (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, enforced):`, ...entries.map((entry) => `- ${entry}`)].join('\n');
}

export async function clearScope(projectRoot: string): Promise<string> {
  await writeScope(projectRoot, { entries: [] });
  return 'Scope cleared — this project is now UNRESTRICTED (no scope enforcement).';
}
