import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { createTwoFilesPatch } from 'diff';
import { resolveProjectPath, validateShellCommand } from './security';
import { listArtifacts, readArtifact, saveArtifact } from './artifacts';
import { forgetProjectEntry, recallProject, rememberProject } from './projectMemory';
import { runCodec, type CodecFormat, type CodecOperation } from './codec';
import {
  addReconTarget,
  formatScanResult,
  listReconTargets,
  reconMonitorStatus,
  removeReconTarget,
  scanRecon,
  startReconMonitor,
  stopReconMonitor,
  touchReconProjectIndex,
} from './recon';
import { addScopeEntry, clearScope, enforceScope, listScope, removeScopeEntry } from './scope';
import { parseScanOutput, type ScanTool } from './scanParsers';
import { addFinding, generateReport, listFindings, updateFindingStatus } from './findings';
import { extractStrings, fileInfoSummary, hexdump, HEXDUMP_DEFAULT_LENGTH, HEXDUMP_MAX_LENGTH, MAX_BINARY_READ_BYTES } from './binaryTools';
import { addChallenge, listBoard, updateChallenge } from './ctfBoard';
import type { ApprovalPreview } from './types';

const execAsync = promisify(exec);
// read_file feeds both the agent's context and the file-preview panel. Anything past this is
// truncated into the API context anyway (see MAX_TOOL_RESULT_CHARS in deepseek.ts), so reading
// tens of megabytes locally only wastes time and memory.
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_EDIT_BYTES = 10 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 8 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 1000;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'release', '.next', 'coverage']);

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'list_directory'
  | 'search_files'
  | 'run_command'
  | 'web_fetch'
  | 'web_search'
  | 'artifact'
  | 'project_memory'
  | 'codec'
  | 'http_request'
  | 'recon'
  | 'scope'
  | 'check_tools'
  | 'parse_scan_output'
  | 'diff_request'
  | 'finding'
  | 'binary'
  | 'ctf_board';

export interface ToolContext {
  projectRoot: string;
  fullControl?: boolean;
}

export interface PreparedToolCall {
  preview: ApprovalPreview;
  execute: () => Promise<string>;
}


export function isMutatingTool(name: string): boolean {
  return name === 'write_file' || name === 'edit_file' || name === 'run_command';
}

export async function executeReadOnlyTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<string> {
  switch (name as ToolName) {
    case 'read_file':
      return readFileTool(context.projectRoot, requireString(args.path, 'path'), context.fullControl);
    case 'list_directory':
      return listDirectoryTool(context.projectRoot, optionalString(args.path) ?? '.', context.fullControl);
    case 'search_files':
      return searchFilesTool(
        context.projectRoot,
        requireString(args.pattern, 'pattern'),
        optionalString(args.path) ?? '.',
        context.fullControl,
      );
    case 'web_fetch':
      return webFetchTool(requireString(args.url, 'url'), args.max_chars);
    case 'web_search':
      return webSearchTool(requireString(args.query, 'query'), args.max_results);
    case 'artifact': {
      const action = requireString(args.action, 'action');
      switch (action) {
        case 'save': {
          const meta = await saveArtifact(context.projectRoot, requireString(args.name, 'name'), requireString(args.content, 'content'), 'manual');
          return `Artifact saved: "${meta.id}" (${(meta.bytes / 1024).toFixed(1)} KB). action:"read" to page through it later instead of re-pasting it.`;
        }
        case 'read':
          return readArtifact(context.projectRoot, requireString(args.name, 'name'), args.offset, args.length);
        case 'list':
          return listArtifacts(context.projectRoot);
        default:
          throw new Error('artifact: action must be "save", "read", or "list".');
      }
    }
    case 'project_memory': {
      const action = requireString(args.action, 'action');
      switch (action) {
        case 'remember': {
          const entry = await rememberProject(context.projectRoot, requireString(args.text, 'text'), optionalString(args.category));
          return `Remembered [${entry.id.slice(0, 8)}] (${entry.category}): ${entry.text}`;
        }
        case 'recall':
          return recallProject(context.projectRoot, optionalString(args.query));
        case 'forget':
          return forgetProjectEntry(context.projectRoot, requireString(args.id, 'id'));
        default:
          throw new Error('project_memory: action must be "remember", "recall", or "forget".');
      }
    }
    case 'codec': {
      const operation = requireString(args.operation, 'operation') as CodecOperation;
      if (operation !== 'encode' && operation !== 'decode') throw new Error('codec: operation must be "encode" or "decode".');
      const format = requireString(args.format, 'format') as CodecFormat;
      const validFormats: CodecFormat[] = ['base64', 'base32', 'hex', 'url', 'rot13', 'morse', 'binary'];
      if (!validFormats.includes(format)) throw new Error(`codec: format must be one of ${validFormats.join(', ')}.`);
      return runCodec(operation, format, requireString(args.text, 'text'));
    }
    case 'http_request': {
      const url = requireString(args.url, 'url');
      const hostname = safeHostname(url, 'http_request');
      await enforceScope(context.projectRoot, hostname, 'http_request');
      return httpRequestTool(requireString(args.method, 'method'), url, args.headers, args.body, args.timeout_ms);
    }
    case 'recon': {
      const action = requireString(args.action, 'action');
      switch (action) {
        case 'add_target': {
          const domain = requireString(args.domain, 'domain');
          await enforceScope(context.projectRoot, domain, 'recon');
          await touchReconProjectIndex(context.projectRoot);
          return addReconTarget(context.projectRoot, domain);
        }
        case 'remove_target':
          return removeReconTarget(context.projectRoot, requireString(args.domain, 'domain'));
        case 'scan': {
          const domain = requireString(args.domain, 'domain');
          await enforceScope(context.projectRoot, domain, 'recon');
          await touchReconProjectIndex(context.projectRoot);
          const result = await scanRecon(context.projectRoot, domain);
          return formatScanResult(result);
        }
        case 'list_targets':
          return listReconTargets(context.projectRoot);
        case 'start_monitor': {
          await touchReconProjectIndex(context.projectRoot);
          const minutes = typeof args.interval_minutes === 'number' ? args.interval_minutes : 30;
          return startReconMonitor(minutes);
        }
        case 'stop_monitor':
          return stopReconMonitor();
        case 'monitor_status':
          return reconMonitorStatus();
        default:
          throw new Error('recon: action must be one of add_target, remove_target, scan, list_targets, start_monitor, stop_monitor, monitor_status.');
      }
    }
    case 'scope': {
      const action = requireString(args.action, 'action');
      switch (action) {
        case 'add':
          return addScopeEntry(context.projectRoot, requireString(args.entry, 'entry'));
        case 'remove':
          return removeScopeEntry(context.projectRoot, requireString(args.entry, 'entry'));
        case 'list':
          return listScope(context.projectRoot);
        case 'clear':
          return clearScope(context.projectRoot);
        default:
          throw new Error('scope: action must be one of add, remove, list, clear.');
      }
    }
    case 'check_tools':
      return checkToolsTool(optionalString(args.names));
    case 'parse_scan_output':
      return parseScanOutput(requireString(args.tool, 'tool') as ScanTool, requireString(args.content, 'content'));
    case 'diff_request': {
      const url = requireString(args.url, 'url');
      const hostname = safeHostname(url, 'diff_request');
      await enforceScope(context.projectRoot, hostname, 'diff_request');
      return diffRequestTool(
        requireString(args.method, 'method'),
        url,
        args.headers_a,
        args.headers_b,
        args.body,
        args.timeout_ms,
      );
    }
    case 'finding': {
      const action = requireString(args.action, 'action');
      switch (action) {
        case 'add': {
          const finding = await addFinding(
            context.projectRoot,
            requireString(args.title, 'title'),
            requireString(args.severity, 'severity'),
            optionalString(args.description) ?? '',
            optionalString(args.evidence) ?? '',
          );
          return `Finding added [${finding.id.slice(0, 8)}] ${finding.severity.toUpperCase()}: ${finding.title}`;
        }
        case 'update_status': {
          const finding = await updateFindingStatus(context.projectRoot, requireString(args.id, 'id'), requireString(args.status, 'status'));
          return `Finding [${finding.id.slice(0, 8)}] status set to ${finding.status}.`;
        }
        case 'list':
          return listFindings(context.projectRoot);
        case 'report':
          return generateReport(context.projectRoot);
        default:
          throw new Error('finding: action must be one of add, update_status, list, report.');
      }
    }
    case 'binary':
      return binaryTool(
        context.projectRoot,
        requireString(args.action, 'action'),
        requireString(args.path, 'path'),
        args.offset,
        args.length,
        args.min_length,
        context.fullControl,
      );
    case 'ctf_board': {
      const action = requireString(args.action, 'action');
      switch (action) {
        case 'add': {
          const points = typeof args.points === 'number' && Number.isFinite(args.points) ? args.points : null;
          const challenge = await addChallenge(context.projectRoot, requireString(args.name, 'name'), optionalString(args.category) ?? 'misc', points);
          return `Added [${challenge.id.slice(0, 8)}] ${challenge.category}/${challenge.name} (status: todo).`;
        }
        case 'update': {
          const challenge = await updateChallenge(
            context.projectRoot,
            requireString(args.id, 'id'),
            optionalString(args.status),
            optionalString(args.notes),
            optionalString(args.flag),
          );
          return `[${challenge.id.slice(0, 8)}] ${challenge.name} → status: ${challenge.status}${challenge.flag ? `, flag: ${challenge.flag}` : ''}.`;
        }
        case 'list':
          return listBoard(context.projectRoot);
        default:
          throw new Error('ctf_board: action must be one of add, update, list.');
      }
    }
    default:
      throw new Error(`Tool ${name} is not read-only or does not exist.`);
  }
}

export async function prepareMutatingTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<PreparedToolCall> {
  switch (name as ToolName) {
    case 'write_file':
      return prepareWriteFile(context.projectRoot, requireString(args.path, 'path'), requireString(args.content, 'content'), context.fullControl);
    case 'edit_file':
      return prepareEditFile(
        context.projectRoot,
        requireString(args.path, 'path'),
        requireString(args.old_string, 'old_string'),
        requireString(args.new_string, 'new_string'),
        context.fullControl,
      );
    case 'run_command':
      return prepareRunCommand(
        context.projectRoot,
        requireString(args.command, 'command'),
        optionalString(args.cwd) ?? '.',
        context.fullControl,
      );
    default:
      throw new Error(`Tool ${name} is not mutating or does not exist.`);
  }
}

const WEB_FETCH_TIMEOUT_MS = 30_000;
const WEB_FETCH_DEFAULT_CHARS = 12_000;
const WEB_FETCH_MAX_CHARS = 60_000;
const WEB_FETCH_MAX_BYTES = 8 * 1024 * 1024;

// Reads a web page's text so the agent can research on its own instead of asking the user to
// paste content (which would be slower and burn far more tokens). Network-only, read-only tool.
async function webFetchTool(rawUrl: string, maxCharsArg?: unknown): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('web_fetch requires a full http:// or https:// URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('web_fetch only supports http:// and https:// URLs.');
  }

  const requested = typeof maxCharsArg === 'number' && Number.isFinite(maxCharsArg)
    ? Math.round(maxCharsArg)
    : WEB_FETCH_DEFAULT_CHARS;
  const maxChars = Math.min(WEB_FETCH_MAX_CHARS, Math.max(1_000, requested));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; DeepSeekCodingDesktop/1.0)',
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
      },
    });
    if (!response.ok) {
      return `web_fetch failed: HTTP ${response.status} ${response.statusText} for ${parsed.toString()}`;
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const buffer = Buffer.from(await response.arrayBuffer());
    const raw = buffer.subarray(0, WEB_FETCH_MAX_BYTES).toString('utf8');
    const head = raw.slice(0, 400).toLowerCase();

    let text: string;
    if (contentType.includes('json')) {
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        text = raw;
      }
    } else if (contentType.includes('html') || head.includes('<html') || head.includes('<!doctype')) {
      text = htmlToText(raw);
    } else {
      text = raw;
    }

    const header = [
      `URL: ${parsed.toString()}`,
      `Content-Type: ${contentType || 'unknown'}`,
      `Bytes: ${buffer.length}${buffer.length > WEB_FETCH_MAX_BYTES ? ` (only first ${WEB_FETCH_MAX_BYTES} read)` : ''}`,
    ].join('\n');

    const body = text.length > maxChars
      ? `${text.slice(0, maxChars)}\n\n[TRUNCATED: ${text.length - maxChars} characters omitted; raise max_chars to read more (max ${WEB_FETCH_MAX_CHARS}).]`
      : text;
    return `${header}\n\n${body || '(no readable text content)'}`;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`web_fetch timed out after ${WEB_FETCH_TIMEOUT_MS / 1000}s for ${parsed.toString()}.`);
    }
    throw new Error(`web_fetch could not reach ${parsed.toString()}: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

const WEB_SEARCH_TIMEOUT_MS = 20_000;
const WEB_SEARCH_DEFAULT_RESULTS = 6;
const WEB_SEARCH_MAX_RESULTS = 15;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// Free, keyless web search so the agent can research on its own instead of only reading a single
// URL the user already found. Scrapes DuckDuckGo's no-JS HTML results page (there is no official
// free search API) — if DuckDuckGo changes that page's markup this parser can start returning zero
// results; that is the first thing to check if web_search stops working.
async function webSearchTool(query: string, maxResultsArg?: unknown): Promise<string> {
  const q = query.trim();
  if (!q) throw new Error('web_search requires a non-empty query.');
  const requested = typeof maxResultsArg === 'number' && Number.isFinite(maxResultsArg)
    ? Math.round(maxResultsArg)
    : WEB_SEARCH_DEFAULT_RESULTS;
  const maxResults = Math.min(WEB_SEARCH_MAX_RESULTS, Math.max(1, requested));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; DeepSeekCodingDesktop/1.0)',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `q=${encodeURIComponent(q)}`,
    });
    if (!response.ok) {
      return `web_search failed: HTTP ${response.status} ${response.statusText} for query "${q}".`;
    }
    const html = await response.text();
    const results = parseDuckDuckGoResults(html).slice(0, maxResults);
    if (results.length === 0) {
      return `web_search: no results parsed for "${q}" (DuckDuckGo may have changed its results page markup, or the query genuinely returned nothing — try rephrasing).`;
    }
    const lines = results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`);
    return [
      `Search results for "${q}":`,
      ...lines,
      '',
      'Use web_fetch on a promising URL above to read its full content.',
    ].join('\n');
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`web_search timed out after ${WEB_SEARCH_TIMEOUT_MS / 1000}s for "${q}".`);
    }
    throw new Error(`web_search could not reach DuckDuckGo: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseDuckDuckGoResults(html: string): SearchResult[] {
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: { url: string; title: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html))) {
    const url = resolveDuckDuckGoUrl(match[1]);
    if (url) links.push({ url, title: htmlToText(match[2]) });
  }
  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html))) {
    snippets.push(htmlToText(match[1]));
  }
  return links.map((link, index) => ({
    title: link.title || '(no title)',
    url: link.url,
    snippet: snippets[index] ?? '',
  }));
}

function resolveDuckDuckGoUrl(href: string): string {
  try {
    const normalized = href.startsWith('//') ? `https:${href}` : href;
    const parsed = new URL(normalized, 'https://duckduckgo.com');
    const real = parsed.searchParams.get('uddg');
    return real ? decodeURIComponent(real) : parsed.toString();
  } catch {
    return '';
  }
}

const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const HTTP_REQUEST_MAX_TIMEOUT_MS = 60_000;
const HTTP_RESPONSE_MAX_CHARS = 20_000;
const HTTP_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const HTTP_METHODS_WITH_NO_BODY = new Set(['GET', 'HEAD']);

interface HttpResponseResult {
  status: number;
  statusText: string;
  elapsedMs: number;
  headers: Record<string, string>;
  body: string;
  bodyBytes: number;
  bodyTruncated: boolean;
}

function parseHeadersArg(headersArg: unknown, toolName: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (headersArg !== undefined) {
    if (typeof headersArg !== 'object' || headersArg === null || Array.isArray(headersArg)) {
      throw new Error(`${toolName}: headers must be an object of string header-name/value pairs.`);
    }
    for (const [key, value] of Object.entries(headersArg as Record<string, unknown>)) {
      if (typeof value !== 'string') throw new Error(`${toolName}: header "${key}" value must be a string.`);
      headers[key] = value;
    }
  }
  return headers;
}

// Shared by http_request and diff_request. No approval gate and no folder scoping beyond the
// usual tool-enabled check, same trust tier as web_fetch (which already allows an arbitrary GET to
// any host) — this is that same trust extended to any method/headers/body, the entire point for
// authorized web bounty/CTF testing. Scope enforcement happens in the tool dispatcher, not here.
async function performHttpRequest(
  method: string,
  parsed: URL,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  toolName: string,
): Promise<HttpResponseResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(parsed.toString(), { method, headers, body, redirect: 'manual', signal: controller.signal });
    const elapsedMs = Date.now() - startedAt;

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });

    const buffer = Buffer.from(await response.arrayBuffer());
    const bodyTruncated = buffer.length > HTTP_RESPONSE_MAX_BYTES;
    const rawBody = buffer.subarray(0, HTTP_RESPONSE_MAX_BYTES).toString('utf8');

    return {
      status: response.status,
      statusText: response.statusText,
      elapsedMs,
      headers: responseHeaders,
      body: rawBody,
      bodyBytes: buffer.length,
      bodyTruncated,
    };
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error(`${toolName} timed out after ${timeoutMs}ms for ${parsed.toString()}.`);
    throw new Error(`${toolName} could not reach ${parsed.toString()}: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function resolveHttpUrl(rawUrl: string, toolName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${toolName} requires a full http:// or https:// URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${toolName} only supports http:// and https:// URLs.`);
  }
  return parsed;
}

function resolveHttpTimeout(timeoutArg: unknown): number {
  const requested = typeof timeoutArg === 'number' && Number.isFinite(timeoutArg) ? Math.round(timeoutArg) : HTTP_REQUEST_TIMEOUT_MS;
  return Math.min(HTTP_REQUEST_MAX_TIMEOUT_MS, Math.max(1_000, requested));
}

// A miniature Repeater: build a raw request (method/headers/body), send it, see the raw response
// back — replay with edited headers/body by just calling this again.
async function httpRequestTool(
  methodArg: string,
  rawUrl: string,
  headersArg: unknown,
  bodyArg: unknown,
  timeoutArg: unknown,
): Promise<string> {
  const method = methodArg.trim().toUpperCase();
  if (!method) throw new Error('http_request requires a method (GET, POST, PUT, PATCH, DELETE, ...).');
  const parsed = resolveHttpUrl(rawUrl, 'http_request');
  const headers = parseHeadersArg(headersArg, 'http_request');
  const body = typeof bodyArg === 'string' && bodyArg.length > 0 ? bodyArg : undefined;
  if (body !== undefined && HTTP_METHODS_WITH_NO_BODY.has(method)) {
    throw new Error(`http_request: ${method} does not send a body — remove it or switch method.`);
  }
  const timeoutMs = resolveHttpTimeout(timeoutArg);

  const result = await performHttpRequest(method, parsed, headers, body, timeoutMs, 'http_request');
  const responseHeaderLines = Object.entries(result.headers).map(([k, v]) => `${k}: ${v}`);
  const bodyOut = result.body.length > HTTP_RESPONSE_MAX_CHARS
    ? `${result.body.slice(0, HTTP_RESPONSE_MAX_CHARS)}\n\n[TRUNCATED: body is ${result.bodyBytes} bytes total, showing the first ${HTTP_RESPONSE_MAX_CHARS} characters.]`
    : result.body;

  return [
    `${method} ${parsed.toString()}`,
    Object.keys(headers).length > 0 ? `Request headers:\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n')}` : '',
    body !== undefined ? `Request body:\n${body}` : '',
    '---',
    `${result.status} ${result.statusText}  (${result.elapsedMs}ms${result.bodyTruncated ? ', body truncated' : ''})`,
    `Response headers:\n${responseHeaderLines.join('\n') || '(none)'}`,
    '',
    bodyOut || '(empty body)',
  ].filter((part) => part !== '').join('\n');
}

const DIFF_RESPONSE_MAX_BODY_CHARS = 20_000;

// Sends the SAME request twice with two different header sets (e.g. two different session
// cookies) and returns only what differs — built for exactly the "logged in as user A vs user B"
// / "authenticated vs not" comparison that catches IDOR/BOLA/broken access control far faster than
// reading two full responses by eye. Deliberately returns a diff, not both full bodies, so the
// token cost stays close to one request instead of two.
async function diffRequestTool(
  methodArg: string,
  rawUrl: string,
  headersAArg: unknown,
  headersBArg: unknown,
  bodyArg: unknown,
  timeoutArg: unknown,
): Promise<string> {
  const method = methodArg.trim().toUpperCase();
  if (!method) throw new Error('diff_request requires a method.');
  const parsed = resolveHttpUrl(rawUrl, 'diff_request');
  const headersA = parseHeadersArg(headersAArg, 'diff_request (headers_a)');
  const headersB = parseHeadersArg(headersBArg, 'diff_request (headers_b)');
  const body = typeof bodyArg === 'string' && bodyArg.length > 0 ? bodyArg : undefined;
  const timeoutMs = resolveHttpTimeout(timeoutArg);

  const [resultA, resultB] = await Promise.all([
    performHttpRequest(method, parsed, headersA, body, timeoutMs, 'diff_request'),
    performHttpRequest(method, parsed, headersB, body, timeoutMs, 'diff_request'),
  ]);

  const lines: string[] = [`${method} ${parsed.toString()} — A vs B`];

  if (resultA.status !== resultB.status) {
    lines.push(`STATUS DIFFERS: A=${resultA.status} ${resultA.statusText}  vs  B=${resultB.status} ${resultB.statusText}`);
  } else {
    lines.push(`Status same: ${resultA.status} ${resultA.statusText}`);
  }

  const allHeaderNames = new Set([...Object.keys(resultA.headers), ...Object.keys(resultB.headers)]);
  const headerDiffLines: string[] = [];
  for (const name of allHeaderNames) {
    const va = resultA.headers[name];
    const vb = resultB.headers[name];
    if (va !== vb) headerDiffLines.push(`  ${name}: A="${va ?? '(absent)'}"  B="${vb ?? '(absent)'}"`);
  }
  lines.push(headerDiffLines.length > 0 ? `Headers that differ:\n${headerDiffLines.join('\n')}` : 'Headers: identical.');

  const bodyA = resultA.body.slice(0, DIFF_RESPONSE_MAX_BODY_CHARS);
  const bodyB = resultB.body.slice(0, DIFF_RESPONSE_MAX_BODY_CHARS);
  if (bodyA === bodyB) {
    lines.push(`Body: IDENTICAL (${bodyA.length} chars compared) — if A and B were meant to be different users/permissions, this is the IDOR/BOLA signal to check.`);
  } else {
    const patch = createTwoFilesPatch('response-A', 'response-B', bodyA, bodyB, '', '', { context: 2 });
    const patchLines = patch.split('\n').filter((line) => !line.startsWith('===') && !line.startsWith('Index:'));
    lines.push(`Body: DIFFERS. Unified diff:\n${patchLines.join('\n')}`);
  }

  return lines.join('\n\n');
}

// Known security tools worth checking for before a task assumes them available — saves losing
// half a CTF/bounty session to "wait, nmap isn't even installed." Windows-only (`where`), plus a
// couple of special cases (pwntools is a Python package, not an executable on PATH).
const KNOWN_TOOL_EXECUTABLES = [
  'nmap', 'ffuf', 'nuclei', 'dalfox', 'sqlmap', 'hydra', 'john', 'hashcat',
  'gdb', 'radare2', 'r2', 'binwalk', 'zsteg', 'volatility', 'volatility3', 'tshark', 'msfconsole',
  'nc', 'ncat', 'curl', 'git', 'python', 'python3',
];

const CHECK_TOOL_TIMEOUT_MS = 5_000;

function checkExecutableOnPath(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('where', [name], { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, CHECK_TOOL_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function checkPwntools(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('python', ['-c', 'import pwn'], { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, CHECK_TOOL_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function checkToolsTool(namesArg?: string): Promise<string> {
  const requested = namesArg
    ? namesArg.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)
    : KNOWN_TOOL_EXECUTABLES;

  const results = await Promise.all(
    requested.map(async (name) => ({ name, found: await checkExecutableOnPath(name) })),
  );
  const pwntoolsFound = requested.includes('pwntools') || !namesArg ? await checkPwntools() : null;

  const lines = results
    .filter((r) => r.name !== 'pwntools')
    .map((r) => `${r.found ? '✓' : '✗'} ${r.name}`);
  if (pwntoolsFound !== null) lines.push(`${pwntoolsFound ? '✓' : '✗'} pwntools (python package)`);

  const missing = results.filter((r) => !r.found).map((r) => r.name);
  const summary = missing.length === 0
    ? 'Everything checked is installed.'
    : `Missing: ${missing.join(', ')}. Not installing anything automatically — tell the user what to install, or use run_command for a package manager they approve.`;

  return [lines.join('\n'), '', summary].join('\n');
}

function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/pre)[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text);
  return text.replace(/[ \t\f\v]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', copy: '©', reg: '®', trade: '™', deg: '°',
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => codePointToChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => codePointToChar(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => HTML_NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function codePointToChar(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

async function readBinary(projectRoot: string, relativePath: string, fullControl?: boolean): Promise<{ buffer: Buffer; totalBytes: number }> {
  const target = await resolveProjectPath(projectRoot, relativePath, { fullControl });
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('binary target is not a file.');
  const handle = await fs.open(target, 'r');
  try {
    const bytesToRead = Math.min(stat.size, MAX_BINARY_READ_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    return { buffer, totalBytes: stat.size };
  } finally {
    await handle.close();
  }
}

async function binaryTool(
  projectRoot: string,
  action: string,
  relativePath: string,
  offsetArg: unknown,
  lengthArg: unknown,
  minLengthArg: unknown,
  fullControl?: boolean,
): Promise<string> {
  const { buffer, totalBytes } = await readBinary(projectRoot, relativePath, fullControl);
  const truncatedNote = totalBytes > buffer.length
    ? `\n[file is ${totalBytes} bytes; only the first ${buffer.length} bytes were read — use offset to look further in.]`
    : '';

  switch (action) {
    case 'info':
      return fileInfoSummary(buffer, totalBytes) + truncatedNote;
    case 'hexdump': {
      const offset = typeof offsetArg === 'number' && Number.isFinite(offsetArg) ? Math.max(0, Math.round(offsetArg)) : 0;
      const requested = typeof lengthArg === 'number' && Number.isFinite(lengthArg) ? Math.round(lengthArg) : HEXDUMP_DEFAULT_LENGTH;
      const length = Math.min(HEXDUMP_MAX_LENGTH, Math.max(16, requested));
      if (offset >= buffer.length) return `Offset ${offset} is past the read window (${buffer.length} bytes available).${truncatedNote}`;
      return hexdump(buffer, offset, length) + truncatedNote;
    }
    case 'strings': {
      const minLength = typeof minLengthArg === 'number' && Number.isFinite(minLengthArg) ? Math.max(2, Math.round(minLengthArg)) : 4;
      const strings = extractStrings(buffer, minLength);
      if (strings.length === 0) return `No printable strings of length >= ${minLength} found.${truncatedNote}`;
      return [`${strings.length} string(s) found (min length ${minLength}):`, ...strings, truncatedNote].filter(Boolean).join('\n');
    }
    default:
      throw new Error('binary: action must be one of hexdump, strings, info.');
  }
}

async function readFileTool(projectRoot: string, relativePath: string, fullControl?: boolean): Promise<string> {
  const target = await resolveProjectPath(projectRoot, relativePath, { fullControl });
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('read_file target is not a file.');

  const handle = await fs.open(target, 'r');
  try {
    const bytesToRead = Math.min(stat.size, MAX_READ_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    const text = buffer.toString('utf8');
    if (stat.size > MAX_READ_BYTES) {
      return `${text}\n\n[TRUNCATED: file is ${stat.size} bytes; read_file limit is ${MAX_READ_BYTES} bytes.]`;
    }
    return text;
  } finally {
    await handle.close();
  }
}

async function listDirectoryTool(projectRoot: string, relativePath: string, fullControl?: boolean): Promise<string> {
  const target = await resolveProjectPath(projectRoot, relativePath, { fullControl });
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error('list_directory target is not a directory.');

  const entries = await fs.readdir(target, { withFileTypes: true });
  const sorted = entries
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 500)
    .map((entry) => `${entry.isDirectory() ? '[DIR] ' : '[FILE]'} ${entry.name}`);

  const suffix = entries.length > 500 ? `\n[TRUNCATED: ${entries.length - 500} more entries]` : '';
  return sorted.join('\n') + suffix;
}

async function searchFilesTool(projectRoot: string, pattern: string, relativePath: string, fullControl?: boolean): Promise<string> {
  if (pattern.length > 500) throw new Error('Search pattern is too long.');
  const target = await resolveProjectPath(projectRoot, relativePath, { fullControl });

  const rgResult = await tryRipgrep(pattern, target, projectRoot);
  if (rgResult !== null) return rgResult;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    regex = new RegExp(escapeRegExp(pattern), 'i');
  }

  const results: string[] = [];
  await searchFallback(target, projectRoot, regex, results);
  return results.length ? results.join('\n') : 'No matches found.';
}

async function tryRipgrep(pattern: string, target: string, projectRoot: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      '--max-count',
      '20',
      '--glob',
      '!node_modules/**',
      '--glob',
      '!.git/**',
      '--glob',
      '!dist/**',
      '--glob',
      '!dist-electron/**',
      '--',
      pattern,
      target,
    ];

    const child = spawn('rg', args, { cwd: projectRoot, windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 256_000) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 32_000) stderr += chunk.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code === 0) {
        const lines = stdout.trim().split(/\r?\n/).slice(0, MAX_SEARCH_RESULTS);
        finish(lines.join('\n') || 'No matches found.');
      } else if (code === 1) {
        finish('No matches found.');
      } else {
        finish(stderr.includes('regex parse error') ? null : `ripgrep failed: ${stderr || `exit code ${code}`}`);
      }
    });
  });
}

async function searchFallback(
  target: string,
  projectRoot: string,
  regex: RegExp,
  results: string[],
): Promise<void> {
  if (results.length >= MAX_SEARCH_RESULTS) return;
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) return;

  if (stat.isFile()) {
    if (stat.size > MAX_READ_BYTES) return;
    let text: string;
    try {
      text = await fs.readFile(target, 'utf8');
    } catch {
      return;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i += 1) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        const relative = path.relative(projectRoot, target) || path.basename(target);
        results.push(`${relative}:${i + 1}:${lines[i].slice(0, 500)}`);
      }
    }
    return;
  }

  if (!stat.isDirectory()) return;
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= MAX_SEARCH_RESULTS) return;
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const child = path.join(target, entry.name);
    try {
      await searchFallback(child, projectRoot, regex, results);
    } catch {
      // Skip unreadable entries.
    }
  }
}

async function prepareWriteFile(projectRoot: string, relativePath: string, content: string, fullControl?: boolean): Promise<PreparedToolCall> {
  if (Buffer.byteLength(content, 'utf8') > MAX_EDIT_BYTES) {
    throw new Error('write_file content exceeds the 10 MB safety limit.');
  }

  const target = await resolveProjectPath(projectRoot, relativePath, { allowMissing: true, fullControl });
  let before = '';
  let existed = false;
  try {
    const existingStat = await fs.stat(target);
    if (!existingStat.isFile()) throw new Error('write_file target exists but is not a file.');
    if (existingStat.size > MAX_EDIT_BYTES) {
      throw new Error('write_file refuses to replace an existing file larger than 1 MB.');
    }
    existed = true;
    before = await fs.readFile(target, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }

  const patch = createTwoFilesPatch(relativePath, relativePath, before, content, 'before', 'after', { context: 4 });
  return {
    preview: {
      kind: 'file',
      title: existed ? `Ghi đè ${relativePath}` : `Tạo mới ${relativePath}`,
      path: relativePath,
      before,
      after: content,
      patch,
      warning: 'Thao tác này ghi vào thư mục dự án đã chọn.',
    },
    execute: async () => {
      // Re-resolve immediately before writing. This re-checks real paths/symlinks
      // after the approval delay instead of trusting only the preview-time path.
      const currentTarget = await resolveProjectPath(projectRoot, relativePath, { allowMissing: !existed, fullControl });
      // Re-check the previewed state immediately before writing so an external
      // edit made while the approval dialog was open is never overwritten silently.
      if (existed) {
        const current = await fs.readFile(currentTarget, 'utf8');
        if (current !== before) {
          throw new Error('write_file cancelled: the target changed after the approval preview was created. Ask the agent to read it again.');
        }
      } else {
        try {
          await fs.stat(currentTarget);
          throw new Error('write_file cancelled: the target was created after the approval preview was created. Ask the agent to inspect it first.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await fs.mkdir(path.dirname(currentTarget), { recursive: true });
      // Resolve again after mkdir in case an existing ancestor changed while approval was pending.
      const finalTarget = await resolveProjectPath(projectRoot, relativePath, { allowMissing: true, fullControl });
      await fs.writeFile(finalTarget, content, 'utf8');
      return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${relativePath}.`;
    },
  };
}

async function prepareEditFile(
  projectRoot: string,
  relativePath: string,
  oldString: string,
  newString: string,
  fullControl?: boolean,
): Promise<PreparedToolCall> {
  if (!oldString) throw new Error('edit_file old_string cannot be empty.');
  const target = await resolveProjectPath(projectRoot, relativePath, { fullControl });
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('edit_file target is not a file.');
  if (stat.size > MAX_EDIT_BYTES) throw new Error('edit_file target exceeds the 10 MB safety limit.');

  const before = await fs.readFile(target, 'utf8');
  const occurrences = before.split(oldString).length - 1;
  if (occurrences === 0) throw new Error('edit_file failed: old_string was not found.');
  if (occurrences > 1) {
    throw new Error(`edit_file failed: old_string appears ${occurrences} times; provide a more specific exact string.`);
  }
  const after = before.replace(oldString, newString);
  const patch = createTwoFilesPatch(relativePath, relativePath, before, after, 'before', 'after', { context: 4 });

  return {
    preview: {
      kind: 'file',
      title: `Sửa ${relativePath}`,
      path: relativePath,
      before,
      after,
      patch,
      warning: 'Thao tác này sửa 1 file có sẵn trong dự án.',
    },
    execute: async () => {
      const currentTarget = await resolveProjectPath(projectRoot, relativePath, { fullControl });
      const current = await fs.readFile(currentTarget, 'utf8');
      if (current !== before) {
        throw new Error('edit_file cancelled: the file changed after the approval preview was created. Ask the agent to read it again.');
      }
      await fs.writeFile(currentTarget, after, 'utf8');
      return `Edited ${relativePath} successfully.`;
    },
  };
}

async function prepareRunCommand(projectRoot: string, command: string, relativeCwd: string, fullControl?: boolean): Promise<PreparedToolCall> {
  validateShellCommand(command, { fullControl });
  const cwd = await resolveProjectPath(projectRoot, relativeCwd, { fullControl });
  const stat = await fs.stat(cwd);
  if (!stat.isDirectory()) throw new Error('run_command cwd is not a directory.');

  return {
    preview: {
      kind: 'command',
      title: 'Chạy lệnh shell',
      command,
      cwd,
      warning: fullControl
        ? 'TOÀN QUYỀN đang bật: lệnh này chạy thẳng, không còn bộ lọc đường dẫn/lệnh nào cả.'
        : 'Quyền chạy shell rất mạnh. Kiểm tra đường dẫn/lệnh chỉ là phòng ngừa, không thay thế sandbox hệ điều hành. Đọc kỹ lệnh trước khi duyệt.',
    },
    execute: async () => {
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          // Command duration costs nothing in API tokens (only the number of agent API calls
          // does), so this is generous on purpose — long enough for slow dev commands like
          // npm run dist:win without cutting them off mid-build.
          timeout: 600_000,
          maxBuffer: MAX_COMMAND_OUTPUT,
          windowsHide: true,
          env: process.env,
        });
        const combined = [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim()}` : '']
          .filter(Boolean)
          .join('\n\n');
        return combined || 'Command completed successfully with no output.';
      } catch (error) {
        const execError = error as Error & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
        const parts = [
          `Command failed${execError.killed ? ' (timed out)' : ''}${execError.code !== undefined ? ` with code ${execError.code}` : ''}.`,
          execError.stdout?.trim() ? `[stdout]\n${execError.stdout.trim()}` : '',
          execError.stderr?.trim() ? `[stderr]\n${execError.stderr.trim()}` : '',
          execError.message,
        ].filter(Boolean);
        return parts.join('\n\n').slice(0, MAX_COMMAND_OUTPUT);
      }
    },
  };
}

export type ComputerToolName =
  | 'computer_screenshot'
  | 'computer_click'
  | 'computer_type'
  | 'computer_key'
  | 'restart_app'
  | 'session';

const COMPUTER_TOOL_NAMES = new Set<ComputerToolName>([
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_key',
  'restart_app',
  'session',
]);

export function isComputerTool(name: string): name is ComputerToolName {
  return COMPUTER_TOOL_NAMES.has(name as ComputerToolName);
}

// --- Interactive sessions (the "session" tool, action: open/write/read/close/list) -------------
// Full Control only, same trust model as the other computer_* tools: once you can pipe arbitrary
// text to a shell's stdin, per-command filtering on the *opening* command is trivially bypassed by
// opening "cmd"/"bash" and typing whatever afterward — so there is no half-restricted version of
// this that means anything. Plain child_process pipes, NOT a real PTY/TTY (no node-pty, keeping
// this project's long-standing rule against native modules and their Electron ABI rebuild pain).
// That covers nc/python/sqlmap/gdb-batch/msfconsole -x fine; a program that behaves differently
// under isatty() (progress bars, some readline prompts) will render slightly differently than in a
// real terminal.
interface ManagedSession {
  id: string;
  command: string;
  cwd: string;
  proc: ReturnType<typeof spawn>;
  buffer: string;
  closed: boolean;
  exitCode: number | null;
  createdAt: number;
}

const MAX_SESSIONS = 6;
const MAX_SESSION_BUFFER_CHARS = 200_000;
const MAX_SESSION_RESULT_CHARS = 12_000;
const sessions = new Map<string, ManagedSession>();

function appendToSession(session: ManagedSession, chunk: string): void {
  session.buffer += chunk;
  if (session.buffer.length > MAX_SESSION_BUFFER_CHARS) {
    session.buffer = session.buffer.slice(session.buffer.length - MAX_SESSION_BUFFER_CHARS);
  }
}

function drainSession(session: ManagedSession): string {
  const out = session.buffer;
  session.buffer = '';
  return out;
}

function boundSessionOutput(value: string): string {
  if (value.length <= MAX_SESSION_RESULT_CHARS) return value;
  const tail = value.slice(value.length - MAX_SESSION_RESULT_CHARS);
  return `[TRUNCATED: ${value.length - MAX_SESSION_RESULT_CHARS} earlier characters omitted]\n${tail}`;
}

function waitMs(delay: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function clampWait(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 1500;
  return Math.min(8000, Math.max(0, n));
}

function mustFindSession(id: string): ManagedSession {
  const session = sessions.get(id);
  if (!session) throw new Error(`No open session with id "${id}". It may already be closed — call session action="open" again.`);
  return session;
}

/** Kills every open session. Called on app quit so relaunch/rebuild never leaves orphan processes. */
export function closeAllSessions(): void {
  for (const session of sessions.values()) {
    if (!session.closed) {
      try {
        session.proc.kill();
      } catch {
        // Already dead.
      }
    }
  }
  sessions.clear();
}

async function sessionOpenTool(
  projectRoot: string,
  command: string,
  cwdArg: string | undefined,
  fullControl?: boolean,
): Promise<string> {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('session action="open" requires a non-empty command.');
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`Too many open sessions (max ${MAX_SESSIONS}). Close one with action="close" first.`);
  }
  const cwd = await resolveProjectPath(projectRoot, cwdArg ?? '.', { fullControl });
  const stat = await fs.stat(cwd);
  if (!stat.isDirectory()) throw new Error('session action="open" cwd is not a directory.');

  const id = randomUUID();
  const proc = spawn(trimmed, { cwd, shell: true, windowsHide: true });
  const session: ManagedSession = { id, command: trimmed, cwd, proc, buffer: '', closed: false, exitCode: null, createdAt: Date.now() };
  proc.stdout?.on('data', (chunk: Buffer) => appendToSession(session, chunk.toString('utf8')));
  proc.stderr?.on('data', (chunk: Buffer) => appendToSession(session, chunk.toString('utf8')));
  proc.on('exit', (code) => {
    session.closed = true;
    session.exitCode = code;
    appendToSession(session, `\n[session exited, code ${code}]\n`);
  });
  proc.on('error', (error) => {
    session.closed = true;
    appendToSession(session, `\n[session error: ${(error as Error).message}]\n`);
  });
  sessions.set(id, session);

  await waitMs(500);
  const initial = drainSession(session);
  return [
    `Session opened: ${id}`,
    `Command: ${trimmed}`,
    `Cwd: ${cwd}`,
    'This is a pipe, not a real TTY — some programs behave slightly differently than in a real terminal.',
    initial ? `--- initial output ---\n${boundSessionOutput(initial)}` : '(no output yet — call session action="read" to check again)',
  ].join('\n');
}

async function sessionWriteTool(id: string, input: string, waitMsArg?: unknown): Promise<string> {
  const session = mustFindSession(id);
  if (session.closed) throw new Error(`Session "${id}" already exited (code ${session.exitCode}). Open a new one with action="open".`);
  session.proc.stdin?.write(`${input}\n`);
  await waitMs(clampWait(waitMsArg));
  const out = drainSession(session);
  return out
    ? boundSessionOutput(out)
    : '(no new output within the wait window — the process may still be working; call session action="read" to check again, or action="write" with a longer wait_ms)';
}

async function sessionReadTool(id: string, waitMsArg?: unknown): Promise<string> {
  const session = mustFindSession(id);
  const delay = clampWait(waitMsArg);
  if (delay > 0) await waitMs(delay);
  const out = drainSession(session);
  if (out) return boundSessionOutput(out);
  return session.closed ? `(session already exited, code ${session.exitCode})` : '(no new output)';
}

function sessionCloseTool(id: string): string {
  const session = mustFindSession(id);
  if (!session.closed) {
    try {
      session.proc.kill();
    } catch {
      // Already dead.
    }
  }
  const remaining = drainSession(session);
  sessions.delete(id);
  return [`Session "${id}" closed.`, remaining ? boundSessionOutput(remaining) : ''].filter(Boolean).join('\n');
}

function sessionListTool(): string {
  if (sessions.size === 0) return 'No open sessions.';
  return [...sessions.values()]
    .map((session) => `${session.id}  ${session.closed ? `exited(${session.exitCode})` : 'running'}  cwd=${session.cwd}  command=${session.command}`)
    .join('\n');
}

const MOUSE_EVENT_TYPE = `
Add-Type -Namespace Native -Name Mouse -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
"@
`;

function runPowerShell(script: string): Promise<string> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('computer_* tools are only implemented for Windows.'));
  }
  return new Promise((resolve, reject) => {
    // Passed as a single argv entry to -Command (no shell involved), so the script's own
    // single/double quotes never need extra escaping for the parent shell.
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('PowerShell command timed out after 20 seconds.'));
    }, 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 32_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code}.`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// SendKeys reserves + ^ % ~ ( ) { } [ ] as special characters; wrap literal text in braces
// so it is typed character-for-character instead of being parsed as a key combo.
function escapeSendKeysLiteral(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (char) => `{${char}}`);
}

const KEY_NAME_MAP: Record<string, string> = {
  enter: '{ENTER}', return: '{ENTER}', esc: '{ESC}', escape: '{ESC}', tab: '{TAB}',
  backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}', space: ' ',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  insert: '{INSERT}', capslock: '{CAPSLOCK}', printscreen: '{PRTSC}',
  f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
  f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
};

// Converts a combo like "ctrl+shift+esc" into SendKeys syntax ("^+{ESC}"). "win" is handled
// separately below since SendKeys cannot send the Windows key.
function toSendKeysCombo(keys: string): { sendKeys: string; usesWin: boolean } {
  const parts = keys.toLowerCase().split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('computer_key: "keys" is empty.');
  let modifiers = '';
  let usesWin = false;
  const mainParts: string[] = [];
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') modifiers += '^';
    else if (part === 'alt') modifiers += '%';
    else if (part === 'shift') modifiers += '+';
    else if (part === 'win' || part === 'windows' || part === 'meta') usesWin = true;
    else mainParts.push(part);
  }
  const mainKey = mainParts.join('') || '';
  const resolved = KEY_NAME_MAP[mainKey] ?? (mainKey.length === 1 ? mainKey : mainKey ? `{${mainKey.toUpperCase()}}` : '');
  return { sendKeys: usesWin ? resolved : `${modifiers}${resolved}`, usesWin };
}

export async function executeComputerTool(
  name: ComputerToolName,
  args: Record<string, unknown>,
  context: { projectRoot: string; fullControl?: boolean },
): Promise<string> {
  switch (name) {
    case 'session': {
      const action = requireString(args.action, 'action');
      switch (action) {
        case 'open':
          return sessionOpenTool(context.projectRoot, requireString(args.command, 'command'), optionalString(args.cwd), context.fullControl);
        case 'write':
          return sessionWriteTool(requireString(args.session_id, 'session_id'), requireString(args.input, 'input'), args.wait_ms);
        case 'read':
          return sessionReadTool(requireString(args.session_id, 'session_id'), args.wait_ms);
        case 'close':
          return sessionCloseTool(requireString(args.session_id, 'session_id'));
        case 'list':
          return sessionListTool();
        default:
          throw new Error('session: action must be one of open, write, read, close, list.');
      }
    }
    case 'computer_screenshot': {
      // Downscaled + JPEG encoded on purpose. A raw full-desktop PNG is 1-4 MB (~5.5 MB as
      // base64) and every screenshot token is resent on every remaining cycle of the run, so
      // the vision cost multiplies. 1280px wide JPEG costs a fraction of that, still fits the
      // inline limit on 4K screens (where the old PNG path threw "larger than 4 MB"), and the
      // scale factor is burned into the image so click coordinates stay derivable.
      const file = path.join(os.tmpdir(), `deepseek-desktop-shot-${randomUUID()}.jpg`);
      const maxWidth = 1280;
      const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$g.Dispose()
$scale = [Math]::Min(1.0, ${maxWidth} / [double]$b.Width)
$nw = [int][Math]::Max(1, [Math]::Round($b.Width * $scale))
$nh = [int][Math]::Max(1, [Math]::Round($b.Height * $scale))
$out = New-Object System.Drawing.Bitmap $nw, ($nh + 26)
$og = [System.Drawing.Graphics]::FromImage($out)
$og.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$og.DrawImage($bmp, 0, 0, $nw, $nh)
$bmp.Dispose()
$ratio = $b.Width / $nw
$label = "scale $($ratio.ToString('0.###'))x | image $nw x $nh maps to screen $($b.Width)x$($b.Height) | image coords x scale = screen coords (label strip is below the screen area)"
$og.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,20,20,20))), 0, $nh, $nw, 26)
$og.DrawString($label, (New-Object System.Drawing.Font('Segoe UI', 11)), (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,235,235,120))), 6, ($nh + 4))
$og.Dispose()
$out.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$out.Dispose()
`;
      await runPowerShell(script);
      const buffer = await fs.readFile(file);
      await fs.unlink(file).catch(() => {});
      if (buffer.length > 4 * 1024 * 1024) {
        throw new Error('Screenshot is larger than 4 MB; cannot inline it in the chat.');
      }
      const base64 = buffer.toString('base64');
      return `data:image/jpeg;base64,${base64}`;
    }
    case 'computer_click': {
      const x = requireNumber(args.x, 'x');
      const y = requireNumber(args.y, 'y');
      const button = optionalString(args.button)?.toLowerCase() ?? 'left';
      const flags: Record<string, [number, number]> = {
        left: [0x0002, 0x0004],
        right: [0x0008, 0x0010],
        double: [0x0002, 0x0004],
      };
      const pair = flags[button];
      if (!pair) throw new Error('computer_click: button must be "left", "right", or "double".');
      const [down, up] = pair;
      const clickScript = `${MOUSE_EVENT_TYPE}
[Native.Mouse]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})
[Native.Mouse]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)
[Native.Mouse]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)
`;
      await runPowerShell(button === 'double' ? clickScript + clickScript : clickScript);
      return `Clicked (${button}) at ${Math.round(x)}, ${Math.round(y)}.`;
    }
    case 'computer_type': {
      const text = requireString(args.text, 'text');
      const escaped = escapeSendKeysLiteral(text).replace(/'/g, "''");
      await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait('${escaped}')`);
      return `Typed ${text.length} characters.`;
    }
    case 'computer_key': {
      const keys = requireString(args.keys, 'keys');
      const { sendKeys, usesWin } = toSendKeysCombo(keys);
      if (usesWin) {
        throw new Error('computer_key: the Windows key combo is not supported by this tool yet.');
      }
      if (!sendKeys) throw new Error(`computer_key: could not resolve "${keys}" to a key combo.`);
      const escaped = sendKeys.replace(/'/g, "''");
      await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait('${escaped}')`);
      return `Pressed ${keys}.`;
    }
    case 'restart_app': {
      // Relaunch through a helper script that waits for this process to fully exit first, THEN
      // starts the new instance. The app holds a single-instance lock, so calling app.relaunch()
      // (which starts the new process immediately, in parallel with this one) risks the new copy
      // losing the lock race and quitting instantly.
      //
      // Getting the helper itself to survive is the actual hard part: Electron's main process
      // belongs to a Windows Job Object with kill-on-close semantics, and Node's
      // spawn(..., {detached:true}) does NOT break a child out of that job — it dies the instant
      // this process exits, before it can do anything, with zero error (confirmed by direct
      // testing: a trivial detached spawn silently never ran). PowerShell's own Start-Process
      // does escape it reliably, so the fix is two hops: this process spawns a short-lived
      // PowerShell that itself calls Start-Process to launch the real wait-and-relaunch script —
      // that inner process is the one that survives past this one exiting.
      const exePath = app.isPackaged ? app.getPath('exe') : null;
      if (exePath) {
        const helperDir = app.getPath('temp');
        const scriptPath = path.join(helperDir, `deepseek-restart-${process.pid}.ps1`);
        const logPath = path.join(app.getPath('userData'), 'restart-helper.log');
        const innerScript = [
          `$log = '${logPath.replace(/'/g, "''")}'`,
          'function Log($msg) { "[$(Get-Date -Format o)] $msg" | Out-File -FilePath $log -Append -Encoding utf8 }',
          `Log 'restart-helper started, waiting for pid ${process.pid} to exit'`,
          `$id = ${process.pid}`,
          '$deadline = (Get-Date).AddSeconds(30)',
          'while ((Get-Process -Id $id -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 250 }',
          'if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Log "gave up waiting for pid $id after 30s, launching anyway" }',
          'Start-Sleep -Milliseconds 700',
          `try { Start-Process -FilePath '${exePath.replace(/'/g, "''")}'; Log 'Start-Process succeeded' } catch { Log "Start-Process FAILED: $($_.Exception.Message)" }`,
        ].join('\n');
        fs.writeFile(scriptPath, innerScript, 'utf8')
          .then(() => {
            const outerScript = `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath.replace(/'/g, "''")}"'`;
            spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outerScript], {
              stdio: 'ignore',
              windowsHide: true,
            }).unref();
          })
          .catch(() => {
            // Writing the helper script failed — fall back to app.relaunch() rather than leaving
            // the app unable to come back at all.
            app.relaunch();
          });
      } else {
        app.relaunch();
      }
      // Delay the exit so the tool result/final message reach the renderer first, AND so the
      // helper-script write + outer spawn above (async) has time to actually fire before this
      // process is gone. app.exit() skips the before-quit event (unlike app.quit()), so open
      // sessions are closed explicitly here instead of relying on that handler.
      closeAllSessions();
      setTimeout(() => app.exit(0), 1200);
      return 'Restarting the app now from the same install path to load the new build.';
    }
    default:
      throw new Error(`Unknown computer tool: ${name}`);
  }
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a number.`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeHostname(rawUrl: string, toolName: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`${toolName}: "${rawUrl}" is not a valid URL.`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
