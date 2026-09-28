// Turns raw scanner output (usually a wall of JSON/JSONL the agent would otherwise have to read
// in full, burning context) into a compact table of just the fields that matter for triage.

export type ScanTool = 'ffuf' | 'nuclei' | 'dalfox' | 'sqlmap';

const MAX_ROWS = 200;

function truncateRows<T>(rows: T[]): { rows: T[]; omitted: number } {
  if (rows.length <= MAX_ROWS) return { rows, omitted: 0 };
  return { rows: rows.slice(0, MAX_ROWS), omitted: rows.length - MAX_ROWS };
}

function parseFfuf(content: string): string {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    throw new Error(`ffuf output is not valid JSON (use -of json / -o file with json format): ${(error as Error).message}`);
  }
  const results = (data as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) throw new Error('ffuf JSON has no "results" array — is this really ffuf -of json output?');

  const rows = results.map((entry) => {
    const r = entry as Record<string, unknown>;
    const input = r.input as Record<string, unknown> | undefined;
    const fuzzValue = input ? Object.values(input)[0] : undefined;
    return `${r.status ?? '?'}\t${r.length ?? '?'}\t${r.words ?? '?'}\t${fuzzValue ?? '?'}\t${r.url ?? ''}`;
  });
  const { rows: kept, omitted } = truncateRows(rows);
  return [
    `ffuf: ${results.length} result(s).`,
    'status\tlength\twords\tinput\turl',
    ...kept,
    omitted > 0 ? `... and ${omitted} more rows omitted.` : '',
  ].filter(Boolean).join('\n');
}

function parseNuclei(content: string): string {
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  const rows: string[] = [];
  let parseErrors = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const info = entry.info as Record<string, unknown> | undefined;
      const templateId = entry['template-id'] ?? entry.templateID ?? '?';
      const severity = info?.severity ?? '?';
      const name = info?.name ?? '?';
      const matchedAt = entry['matched-at'] ?? entry.host ?? '?';
      rows.push(`${severity}\t${templateId}\t${name}\t${matchedAt}`);
    } catch {
      parseErrors += 1;
    }
  }
  if (rows.length === 0) {
    throw new Error(`No valid nuclei JSONL lines parsed (use -jsonl for one JSON object per line).${parseErrors > 0 ? ` ${parseErrors} line(s) failed to parse.` : ''}`);
  }
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4, unknown: 5 };
  rows.sort((a, b) => {
    const sevA = severityOrder[a.split('\t')[0]] ?? 5;
    const sevB = severityOrder[b.split('\t')[0]] ?? 5;
    return sevA - sevB;
  });
  const { rows: kept, omitted } = truncateRows(rows);
  return [
    `nuclei: ${rows.length} finding(s), sorted by severity.${parseErrors > 0 ? ` (${parseErrors} unparsable line(s) skipped)` : ''}`,
    'severity\ttemplate-id\tname\tmatched-at',
    ...kept,
    omitted > 0 ? `... and ${omitted} more rows omitted.` : '',
  ].join('\n');
}

function parseDalfox(content: string): string {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    throw new Error(`dalfox output is not valid JSON (use --format json): ${(error as Error).message}`);
  }
  const list = Array.isArray(data) ? data : [data];
  const rows = list.map((entry) => {
    const r = entry as Record<string, unknown>;
    const type = r.type ?? '?';
    const param = r.param ?? '?';
    const severity = r.severity ?? r.cwe ?? '?';
    const evidence = r.evidence ?? r.poc ?? r.message_str ?? '';
    return `${severity}\t${type}\t${param}\t${String(evidence).slice(0, 120)}`;
  });
  const { rows: kept, omitted } = truncateRows(rows);
  return [
    `dalfox: ${list.length} finding(s).`,
    'severity/cwe\ttype\tparam\tevidence',
    ...kept,
    omitted > 0 ? `... and ${omitted} more rows omitted.` : '',
  ].join('\n');
}

// sqlmap has no clean single-shot JSON output mode in common use, so this extracts the
// human-readable "Parameter: X (Y)" / "Type: ..." / "Payload: ..." blocks from its normal log text.
function parseSqlmap(content: string): string {
  const paramBlocks = content.split(/\nParameter:\s*/).slice(1);
  if (paramBlocks.length === 0) {
    throw new Error('No "Parameter:" blocks found — this doesn\'t look like sqlmap log output with a confirmed injection.');
  }
  const rows = paramBlocks.map((block) => {
    const header = block.split('\n')[0].trim();
    const typeMatch = block.match(/Type:\s*(.+)/);
    const titleMatch = block.match(/Title:\s*(.+)/);
    const payloadMatch = block.match(/Payload:\s*(.+)/);
    return [
      `Parameter: ${header}`,
      typeMatch ? `  Type: ${typeMatch[1].trim()}` : '',
      titleMatch ? `  Title: ${titleMatch[1].trim()}` : '',
      payloadMatch ? `  Payload: ${payloadMatch[1].trim()}` : '',
    ].filter(Boolean).join('\n');
  });
  return [`sqlmap: ${rows.length} injectable parameter(s) found.`, ...rows].join('\n\n');
}

export function parseScanOutput(tool: ScanTool, content: string): string {
  switch (tool) {
    case 'ffuf':
      return parseFfuf(content);
    case 'nuclei':
      return parseNuclei(content);
    case 'dalfox':
      return parseDalfox(content);
    case 'sqlmap':
      return parseSqlmap(content);
    default:
      throw new Error(`parse_scan_output: unknown tool "${tool as string}" — must be ffuf, nuclei, dalfox, or sqlmap.`);
  }
}
