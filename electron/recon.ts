import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { app, Notification } from 'electron';

// "Bất khả chiến bại về mặt kinh tế" per Lục Trầm's own framing: on a crowded bounty program a bug
// gets claimed within hours, so the actual edge is running recon continuously and getting pinged
// the moment a new asset appears — not finding bugs faster once you already know an asset exists.
// crt.sh is used for subdomain discovery: it is a free, keyless, public certificate-transparency
// search (https://crt.sh/?q=%25.example.com&output=json), not a paid recon API.

export interface ReconTarget {
  domain: string;
  addedAt: string;
  lastScanAt: string | null;
  subdomains: string[];
}

interface ReconStore {
  targets: ReconTarget[];
}

const MAX_SUBDOMAINS_PER_TARGET = 5_000;
const CRTSH_TIMEOUT_MS = 20_000;
const DNS_CHECK_TIMEOUT_MS = 4_000;
const DNS_CHECK_CONCURRENCY = 20;
const DNS_CHECK_CAP = 200; // only alive-check up to this many new hosts per scan, to keep it fast

function reconFileFor(projectRoot: string): string {
  const key = crypto.createHash('sha1').update(projectRoot).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'recon', `${key}.json`);
}

async function readStore(projectRoot: string): Promise<ReconStore> {
  try {
    const raw = await fs.readFile(reconFileFor(projectRoot), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ReconStore>;
    return { targets: Array.isArray(parsed.targets) ? parsed.targets : [] };
  } catch {
    return { targets: [] };
  }
}

async function writeStore(projectRoot: string, store: ReconStore): Promise<void> {
  const file = reconFileFor(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(store, null, 2), 'utf8');
}

function normalizeDomain(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!trimmed || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed)) {
    throw new Error(`"${input}" does not look like a bare domain (expected e.g. "example.com", not a full URL).`);
  }
  return trimmed;
}

async function fetchCrtShSubdomains(domain: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CRTSH_TIMEOUT_MS);
  try {
    const response = await fetch(`https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; DeepSeekCodingDesktop-ReconMonitor/1.0)' },
    });
    if (!response.ok) throw new Error(`crt.sh returned HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim()) return [];
    let rows: Array<{ name_value?: string }>;
    try {
      rows = JSON.parse(text);
    } catch {
      throw new Error('crt.sh response was not valid JSON (it may be rate-limiting — try again later).');
    }
    const names = new Set<string>();
    for (const row of rows) {
      if (!row.name_value) continue;
      for (const line of row.name_value.split('\n')) {
        const name = line.trim().toLowerCase().replace(/^\*\./, '');
        if (name.endsWith(`.${domain}`) || name === domain) names.add(name);
      }
    }
    return [...names];
  } finally {
    clearTimeout(timer);
  }
}

async function isAlive(host: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DNS_CHECK_TIMEOUT_MS);
  try {
    await dns.lookup(host, { signal: controller.signal } as never);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function checkAliveBatch(hosts: string[]): Promise<Map<string, boolean>> {
  const capped = hosts.slice(0, DNS_CHECK_CAP);
  const result = new Map<string, boolean>();
  let index = 0;
  async function worker(): Promise<void> {
    while (index < capped.length) {
      const host = capped[index];
      index += 1;
      result.set(host, await isAlive(host));
    }
  }
  await Promise.all(Array.from({ length: Math.min(DNS_CHECK_CONCURRENCY, capped.length) }, () => worker()));
  return result;
}

export interface ReconScanResult {
  domain: string;
  totalSubdomains: number;
  newSubdomains: string[];
  aliveNewCount: number;
  checkedAliveCount: number;
}

export async function scanRecon(projectRoot: string, domainArg: string): Promise<ReconScanResult> {
  const domain = normalizeDomain(domainArg);
  const store = await readStore(projectRoot);
  let target = store.targets.find((entry) => entry.domain === domain);
  if (!target) {
    target = { domain, addedAt: new Date().toISOString(), lastScanAt: null, subdomains: [] };
    store.targets.push(target);
  }

  const fetched = await fetchCrtShSubdomains(domain);
  const known = new Set(target.subdomains);
  const newOnes = fetched.filter((name) => !known.has(name));

  const aliveMap = newOnes.length > 0 ? await checkAliveBatch(newOnes) : new Map<string, boolean>();
  const aliveNewCount = [...aliveMap.values()].filter(Boolean).length;

  const merged = new Set([...target.subdomains, ...fetched]);
  target.subdomains = [...merged].sort().slice(0, MAX_SUBDOMAINS_PER_TARGET);
  target.lastScanAt = new Date().toISOString();
  await writeStore(projectRoot, store);

  return {
    domain,
    totalSubdomains: target.subdomains.length,
    newSubdomains: newOnes,
    aliveNewCount,
    checkedAliveCount: aliveMap.size,
  };
}

export function formatScanResult(result: ReconScanResult): string {
  const lines = [
    `Scanned ${result.domain}: ${result.totalSubdomains} known subdomain(s) total.`,
  ];
  if (result.newSubdomains.length === 0) {
    lines.push('No new subdomains since the last scan.');
  } else {
    lines.push(`${result.newSubdomains.length} NEW since last scan (${result.aliveNewCount}/${result.checkedAliveCount} checked resolve right now):`);
    lines.push(...result.newSubdomains.slice(0, 100).map((name) => `- ${name}`));
    if (result.newSubdomains.length > 100) lines.push(`...and ${result.newSubdomains.length - 100} more.`);
  }
  return lines.join('\n');
}

export async function addReconTarget(projectRoot: string, domainArg: string): Promise<string> {
  const domain = normalizeDomain(domainArg);
  const store = await readStore(projectRoot);
  if (store.targets.some((entry) => entry.domain === domain)) {
    return `${domain} is already being monitored for this project.`;
  }
  store.targets.push({ domain, addedAt: new Date().toISOString(), lastScanAt: null, subdomains: [] });
  await writeStore(projectRoot, store);
  return `Added ${domain} to recon monitoring for this project. Use recon action=scan to run the first scan, or action=start_monitor to scan it automatically on a schedule.`;
}

export async function removeReconTarget(projectRoot: string, domainArg: string): Promise<string> {
  const domain = normalizeDomain(domainArg);
  const store = await readStore(projectRoot);
  const next = store.targets.filter((entry) => entry.domain !== domain);
  if (next.length === store.targets.length) throw new Error(`${domain} is not being monitored for this project.`);
  await writeStore(projectRoot, { targets: next });
  return `Stopped monitoring ${domain} for this project.`;
}

export async function listReconTargets(projectRoot: string): Promise<string> {
  const store = await readStore(projectRoot);
  if (store.targets.length === 0) return 'No recon targets added yet for this project. Use recon action=add_target to add one.';
  return store.targets
    .map((target) => `${target.domain}  ${target.subdomains.length} known subdomain(s)  last scan: ${target.lastScanAt ?? 'never'}`)
    .join('\n');
}

// --- Background monitor -------------------------------------------------------------------------
// Runs inside this Electron process only — "background" means "while the app is open", not a
// separate OS service. Say this plainly to the user rather than overselling it: closing the app
// stops the monitor, same as any other in-app timer.

let monitorTimer: NodeJS.Timeout | null = null;
let monitorIntervalMinutes = 0;
let monitorLastError: string | null = null;

async function findAllReconProjectRoots(): Promise<string[]> {
  // The store only knows domain->projectRoot via the hashed filename, so this keeps a small
  // side index of hash->real path alongside the per-project files.
  const indexFile = path.join(app.getPath('userData'), 'recon', '_project-index.json');
  try {
    const raw = await fs.readFile(indexFile, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.values(parsed);
  } catch {
    return [];
  }
}

async function recordProjectRootInIndex(projectRoot: string): Promise<void> {
  const indexFile = path.join(app.getPath('userData'), 'recon', '_project-index.json');
  const key = crypto.createHash('sha1').update(projectRoot).digest('hex').slice(0, 16);
  let index: Record<string, string> = {};
  try {
    index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  } catch {
    // First time.
  }
  index[key] = projectRoot;
  await fs.mkdir(path.dirname(indexFile), { recursive: true });
  await fs.writeFile(indexFile, JSON.stringify(index, null, 2), 'utf8');
}

async function runMonitorTick(): Promise<void> {
  try {
    const roots = await findAllReconProjectRoots();
    for (const projectRoot of roots) {
      const store = await readStore(projectRoot);
      for (const target of store.targets) {
        try {
          const result = await scanRecon(projectRoot, target.domain);
          if (result.newSubdomains.length > 0 && Notification.isSupported()) {
            new Notification({
              title: `Lục Trầm — ${result.newSubdomains.length} asset mới trên ${result.domain}`,
              body: result.newSubdomains.slice(0, 5).join(', ') + (result.newSubdomains.length > 5 ? '…' : ''),
            }).show();
          }
        } catch (error) {
          monitorLastError = `${target.domain}: ${(error as Error).message}`;
        }
      }
    }
  } catch (error) {
    monitorLastError = (error as Error).message;
  }
}

export function startReconMonitor(intervalMinutes: number): string {
  const minutes = Math.min(1440, Math.max(5, Math.round(intervalMinutes)));
  if (monitorTimer) clearInterval(monitorTimer);
  monitorIntervalMinutes = minutes;
  monitorTimer = setInterval(() => void runMonitorTick(), minutes * 60_000);
  void runMonitorTick(); // also run one pass immediately
  return `Recon monitor started: rescanning every ${minutes} minute(s) while the app stays open. You'll get a Windows notification when a new subdomain shows up. Closing the app stops this — it is not a separate background service.`;
}

export function stopReconMonitor(): string {
  if (!monitorTimer) return 'Recon monitor was not running.';
  clearInterval(monitorTimer);
  monitorTimer = null;
  monitorIntervalMinutes = 0;
  return 'Recon monitor stopped.';
}

export function reconMonitorStatus(): string {
  if (!monitorTimer) return 'Recon monitor: OFF.';
  return `Recon monitor: ON, rescanning every ${monitorIntervalMinutes} minute(s).${monitorLastError ? ` Last error: ${monitorLastError}` : ''}`;
}

export function stopReconMonitorOnQuit(): void {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}

// Called whenever a recon tool runs so the background monitor later knows this project exists.
export async function touchReconProjectIndex(projectRoot: string): Promise<void> {
  await recordProjectRootInIndex(projectRoot);
}
