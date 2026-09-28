import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';

// A bug-bounty/CTF engagement is a marathon across many days and many separate chat sessions in
// the same project folder. Without this, the agent starts every new chat from zero — scope,
// credentials, endpoints already found, payloads already tried and failed, all forgotten. This is
// keyed by working directory (not by chat session) and loaded automatically into every new run's
// system prompt, the same way Claude's own cross-conversation memory works for the user.

export interface ProjectMemoryEntry {
  id: string;
  category: string;
  text: string;
  createdAt: string;
}

const MAX_ENTRIES = 300;
const MAX_ENTRY_CHARS = 2_000;
// Injected into every request's system prompt, so this budget is a direct, permanent cost lever —
// kept small on purpose (see the same reasoning as MAX_TOOL_RESULT_CHARS in deepseek.ts).
const INJECT_CHAR_BUDGET = 4_000;
const INJECT_MAX_ENTRIES = 40;

function memoryFileFor(projectRoot: string): string {
  const key = crypto.createHash('sha1').update(projectRoot).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'project-memory', `${key}.json`);
}

async function readEntries(projectRoot: string): Promise<ProjectMemoryEntry[]> {
  try {
    const raw = await fs.readFile(memoryFileFor(projectRoot), 'utf8');
    const parsed = JSON.parse(raw) as { entries?: ProjectMemoryEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

async function writeEntries(projectRoot: string, entries: ProjectMemoryEntry[]): Promise<void> {
  const file = memoryFileFor(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ entries }, null, 2), 'utf8');
}

export async function rememberProject(projectRoot: string, text: string, categoryArg?: string): Promise<ProjectMemoryEntry> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('project_memory action=remember requires non-empty text.');
  if (trimmed.length > MAX_ENTRY_CHARS) {
    throw new Error(`project_memory text is ${trimmed.length} characters, over the ${MAX_ENTRY_CHARS} cap — keep it to one fact/finding at a time, not a whole transcript dump.`);
  }
  const category = (categoryArg && categoryArg.trim().slice(0, 40)) || 'note';
  const entries = await readEntries(projectRoot);
  const entry: ProjectMemoryEntry = { id: randomUUID(), category, text: trimmed, createdAt: new Date().toISOString() };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  await writeEntries(projectRoot, entries);
  return entry;
}

export async function recallProject(projectRoot: string, query?: string): Promise<string> {
  const entries = await readEntries(projectRoot);
  if (entries.length === 0) return 'No project memory saved yet.';
  const q = query?.trim().toLowerCase();
  const filtered = q ? entries.filter((entry) => entry.text.toLowerCase().includes(q) || entry.category.toLowerCase().includes(q)) : entries;
  if (filtered.length === 0) return `No project memory entries match "${query}".`;
  return filtered
    .slice()
    .reverse()
    .map((entry) => `[${entry.id.slice(0, 8)}] (${entry.category}) ${entry.createdAt}\n${entry.text}`)
    .join('\n\n');
}

export async function forgetProjectEntry(projectRoot: string, idPrefix: string): Promise<string> {
  const trimmed = idPrefix.trim();
  if (!trimmed) throw new Error('project_memory action=forget requires an entry id (or id prefix).');
  const entries = await readEntries(projectRoot);
  const matches = entries.filter((entry) => entry.id === trimmed || entry.id.startsWith(trimmed));
  if (matches.length === 0) throw new Error(`No project memory entry matching id "${trimmed}" (call project_memory action=recall to see ids).`);
  if (matches.length > 1) throw new Error(`"${trimmed}" matches ${matches.length} entries — use a longer id prefix to be specific.`);
  const next = entries.filter((entry) => entry.id !== matches[0].id);
  await writeEntries(projectRoot, next);
  return `Forgot [${matches[0].id.slice(0, 8)}] (${matches[0].category}): ${matches[0].text.slice(0, 80)}`;
}

/** Compact, budget-capped summary for automatic injection into every new run's system prompt. */
export async function loadProjectMemoryForPrompt(projectRoot: string): Promise<string | null> {
  const entries = await readEntries(projectRoot);
  if (entries.length === 0) return null;

  const recent = entries.slice(-INJECT_MAX_ENTRIES).reverse();
  const lines: string[] = [];
  let used = 0;
  for (const entry of recent) {
    const line = `- (${entry.category}) ${entry.text}`;
    if (used + line.length > INJECT_CHAR_BUDGET) break;
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return null;

  const omitted = entries.length - lines.length;
  return [
    `${entries.length} remembered fact(s) from earlier work on this project${omitted > 0 ? ` (showing the ${lines.length} most recent)` : ''}:`,
    ...lines,
    omitted > 0 ? `(${omitted} older entr${omitted === 1 ? 'y' : 'ies'} not shown here — use project_memory action=recall with a search term to find them)` : '',
  ].filter(Boolean).join('\n');
}
