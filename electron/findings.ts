import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';

// Per Lục Trầm's own point: bounty dies at the report stage, not the finding stage. This gives
// findings a structured home (severity, evidence, repro) instead of scattered chat text, and a
// one-shot report generator so writing it up isn't its own separate chore.

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'open' | 'reported' | 'fixed' | 'wontfix' | 'duplicate';

export interface Finding {
  id: string;
  title: string;
  severity: FindingSeverity;
  status: FindingStatus;
  description: string;
  evidence: string;
  createdAt: string;
  updatedAt: string;
}

interface FindingStore {
  findings: Finding[];
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const VALID_SEVERITIES: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
const VALID_STATUSES: FindingStatus[] = ['open', 'reported', 'fixed', 'wontfix', 'duplicate'];

function findingsFileFor(projectRoot: string): string {
  const key = crypto.createHash('sha1').update(projectRoot).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'findings', `${key}.json`);
}

async function readStore(projectRoot: string): Promise<FindingStore> {
  try {
    const raw = await fs.readFile(findingsFileFor(projectRoot), 'utf8');
    const parsed = JSON.parse(raw) as Partial<FindingStore>;
    return { findings: Array.isArray(parsed.findings) ? parsed.findings : [] };
  } catch {
    return { findings: [] };
  }
}

async function writeStore(projectRoot: string, store: FindingStore): Promise<void> {
  const file = findingsFileFor(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(store, null, 2), 'utf8');
}

function normalizeSeverity(value: string): FindingSeverity {
  const lower = value.trim().toLowerCase();
  if (!VALID_SEVERITIES.includes(lower as FindingSeverity)) {
    throw new Error(`finding: severity must be one of ${VALID_SEVERITIES.join(', ')}.`);
  }
  return lower as FindingSeverity;
}

function normalizeStatus(value: string): FindingStatus {
  const lower = value.trim().toLowerCase();
  if (!VALID_STATUSES.includes(lower as FindingStatus)) {
    throw new Error(`finding: status must be one of ${VALID_STATUSES.join(', ')}.`);
  }
  return lower as FindingStatus;
}

export async function addFinding(
  projectRoot: string,
  title: string,
  severityArg: string,
  description: string,
  evidence: string,
): Promise<Finding> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw new Error('finding action=add requires a title.');
  const severity = normalizeSeverity(severityArg);
  const now = new Date().toISOString();
  const finding: Finding = {
    id: randomUUID(),
    title: trimmedTitle,
    severity,
    status: 'open',
    description: description.trim(),
    evidence: evidence.trim(),
    createdAt: now,
    updatedAt: now,
  };
  const store = await readStore(projectRoot);
  store.findings.push(finding);
  await writeStore(projectRoot, store);
  return finding;
}

export async function updateFindingStatus(projectRoot: string, idPrefix: string, statusArg: string): Promise<Finding> {
  const status = normalizeStatus(statusArg);
  const store = await readStore(projectRoot);
  const matches = store.findings.filter((f) => f.id === idPrefix || f.id.startsWith(idPrefix));
  if (matches.length === 0) throw new Error(`No finding matching id "${idPrefix}" (call finding action=list to see ids).`);
  if (matches.length > 1) throw new Error(`"${idPrefix}" matches ${matches.length} findings — use a longer id prefix.`);
  matches[0].status = status;
  matches[0].updatedAt = new Date().toISOString();
  await writeStore(projectRoot, store);
  return matches[0];
}

export async function listFindings(projectRoot: string): Promise<string> {
  const { findings } = await readStore(projectRoot);
  if (findings.length === 0) return 'No findings recorded for this project yet.';
  const sorted = findings.slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return sorted
    .map((f) => `[${f.id.slice(0, 8)}] ${f.severity.toUpperCase()} · ${f.status} · ${f.title}`)
    .join('\n');
}

export async function generateReport(projectRoot: string): Promise<string> {
  const { findings } = await readStore(projectRoot);
  if (findings.length === 0) return 'No findings recorded for this project yet — nothing to report.';
  const sorted = findings.slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const counts = VALID_SEVERITIES.map((sev) => `${sev}: ${findings.filter((f) => f.severity === sev).length}`).join(', ');
  const sections = sorted.map((f, index) => [
    `## ${index + 1}. ${f.title}`,
    '',
    `**Severity:** ${f.severity.toUpperCase()}  |  **Status:** ${f.status}  |  **ID:** ${f.id.slice(0, 8)}`,
    '',
    '### Description',
    f.description || '(none)',
    '',
    '### Evidence / Reproduction',
    '```',
    f.evidence || '(none)',
    '```',
  ].join('\n'));

  return [
    `# Findings Report`,
    '',
    `Generated ${new Date().toISOString()} — ${findings.length} finding(s) (${counts}).`,
    '',
    ...sections,
  ].join('\n');
}
