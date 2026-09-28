import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';

// Per Lục Trầm: "biết khi nào đủ rồi, chuyển" cứu cả trận — a board across many parallel
// challenges makes that call visible instead of it living only in the agent's (or the user's)
// head, and gets lost the moment the chat scrolls.

export type CtfStatus = 'todo' | 'in_progress' | 'stuck' | 'solved' | 'skipped';

export interface CtfChallenge {
  id: string;
  name: string;
  category: string;
  status: CtfStatus;
  points: number | null;
  notes: string;
  flag: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CtfStore {
  challenges: CtfChallenge[];
}

const VALID_STATUSES: CtfStatus[] = ['todo', 'in_progress', 'stuck', 'solved', 'skipped'];
const STATUS_ORDER: Record<CtfStatus, number> = { in_progress: 0, stuck: 1, todo: 2, solved: 3, skipped: 4 };

function boardFileFor(projectRoot: string): string {
  const key = crypto.createHash('sha1').update(projectRoot).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'ctf-board', `${key}.json`);
}

async function readStore(projectRoot: string): Promise<CtfStore> {
  try {
    const raw = await fs.readFile(boardFileFor(projectRoot), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CtfStore>;
    return { challenges: Array.isArray(parsed.challenges) ? parsed.challenges : [] };
  } catch {
    return { challenges: [] };
  }
}

async function writeStore(projectRoot: string, store: CtfStore): Promise<void> {
  const file = boardFileFor(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(store, null, 2), 'utf8');
}

function normalizeStatus(value: string): CtfStatus {
  const lower = value.trim().toLowerCase();
  if (!VALID_STATUSES.includes(lower as CtfStatus)) {
    throw new Error(`ctf_board: status must be one of ${VALID_STATUSES.join(', ')}.`);
  }
  return lower as CtfStatus;
}

export async function addChallenge(
  projectRoot: string,
  name: string,
  category: string,
  points: number | null,
): Promise<CtfChallenge> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('ctf_board action=add requires a name.');
  const store = await readStore(projectRoot);
  if (store.challenges.some((c) => c.name.toLowerCase() === trimmedName.toLowerCase())) {
    throw new Error(`"${trimmedName}" is already on the board — use action=update to change its status.`);
  }
  const now = new Date().toISOString();
  const challenge: CtfChallenge = {
    id: randomUUID(),
    name: trimmedName,
    category: category.trim() || 'misc',
    status: 'todo',
    points: points ?? null,
    notes: '',
    flag: null,
    createdAt: now,
    updatedAt: now,
  };
  store.challenges.push(challenge);
  await writeStore(projectRoot, store);
  return challenge;
}

function findChallenge(store: CtfStore, idOrName: string): CtfChallenge {
  const byId = store.challenges.find((c) => c.id === idOrName || c.id.startsWith(idOrName));
  if (byId) return byId;
  const byName = store.challenges.find((c) => c.name.toLowerCase() === idOrName.toLowerCase());
  if (byName) return byName;
  throw new Error(`No challenge matching "${idOrName}" (call ctf_board action=list to see what's on the board).`);
}

export async function updateChallenge(
  projectRoot: string,
  idOrName: string,
  statusArg?: string,
  notes?: string,
  flag?: string,
): Promise<CtfChallenge> {
  const store = await readStore(projectRoot);
  const challenge = findChallenge(store, idOrName);
  if (statusArg) challenge.status = normalizeStatus(statusArg);
  if (notes !== undefined) challenge.notes = notes.trim();
  if (flag !== undefined) challenge.flag = flag.trim() || null;
  if (flag && challenge.status !== 'solved') challenge.status = 'solved';
  challenge.updatedAt = new Date().toISOString();
  await writeStore(projectRoot, store);
  return challenge;
}

export async function listBoard(projectRoot: string): Promise<string> {
  const { challenges } = await readStore(projectRoot);
  if (challenges.length === 0) return 'No challenges on the board yet. Use ctf_board action=add to start tracking one.';
  const sorted = challenges.slice().sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const solved = challenges.filter((c) => c.status === 'solved');
  const solvedPoints = solved.reduce((sum, c) => sum + (c.points ?? 0), 0);
  const lines = sorted.map((c) => {
    const pts = c.points !== null ? ` (${c.points}pts)` : '';
    const flagNote = c.flag ? ` — flag: ${c.flag}` : '';
    return `[${c.id.slice(0, 8)}] ${c.status.toUpperCase().padEnd(11)} ${c.category.padEnd(10)} ${c.name}${pts}${flagNote}`;
  });
  return [
    `${challenges.length} challenge(s), ${solved.length} solved${solvedPoints > 0 ? ` (${solvedPoints} pts)` : ''}.`,
    ...lines,
  ].join('\n');
}
