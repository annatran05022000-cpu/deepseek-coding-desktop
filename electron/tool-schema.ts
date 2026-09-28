export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file. Capped ~2MB / ~32k chars sent (middle removed); prefer search_files or a narrow read for huge files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a file, or replace an existing file\'s full contents. For an existing file where only part changes, prefer edit_file (cheaper: only the diff is generated).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory.' },
          content: { type: 'string', description: 'Complete new file contents.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace exactly one occurrence of old_string with new_string in a file. Fails if old_string is missing or not unique.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory.' },
          old_string: { type: 'string', description: 'Exact text to replace.' },
          new_string: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List one directory level inside the working directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to the working directory. "." for root.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search text across project files (ripgrep if installed, else a bounded regex search).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex/text pattern.' },
          path: { type: 'string', description: 'Directory or file path relative to the working directory. Default ".".' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run one shell command. Times out at 10 min; output truncated ~32k chars — keep it small (filters/limits).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run.' },
          cwd: { type: 'string', description: 'Working directory relative to the project root. Default ".".' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch an http/https URL as readable text (tags/scripts stripped). Use for docs/articles/APIs instead of asking the user to paste them.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full http:// or https:// URL.' },
          max_chars: { type: 'number', description: 'Max chars returned (default 12000, max 60000).' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Free keyless web search (DuckDuckGo) — returns title/URL/snippet list. Use before web_fetch when you have no URL yet.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          max_results: { type: 'number', description: 'Default 6, max 15.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'artifact',
      description: 'Park long text (scan output, big response bodies, wordlists) outside the conversation instead of keeping/re-pasting it in full. Truncated tool results auto-save here too.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"save" | "read" | "list".' },
          name: { type: 'string', description: 'Artifact id. Required for save/read. Same name on save overwrites.' },
          content: { type: 'string', description: 'Full text to save. Required for save.' },
          offset: { type: 'number', description: 'read: start offset (default 0).' },
          length: { type: 'number', description: 'read: max chars (default 8000, max 20000).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'project_memory',
      description: 'Facts kept across chats for this project (scope, credential, endpoint, failed payload, decision) — remembered facts auto-load into every new chat here.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"remember" | "recall" | "forget".' },
          text: { type: 'string', description: 'remember: one focused fact.' },
          category: { type: 'string', description: 'remember: e.g. "scope", "credential", "endpoint", "failed-payload", "decision". Default "note".' },
          query: { type: 'string', description: 'recall: filter text (matches fact or category). Omit to list all.' },
          id: { type: 'string', description: 'forget: entry id or prefix (shown by recall).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: 'Send a raw HTTP request (any method/headers/body), see the raw response. Redirects are NOT auto-followed. Call again with edited args to replay (Repeater-style). Refused if the host is outside this project\'s scope (see the scope tool).',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, ...' },
          url: { type: 'string', description: 'Full http:// or https:// URL.' },
          headers: { type: 'object', description: 'Optional {"Header-Name": "value"}.' },
          body: { type: 'string', description: 'Optional raw body (not for GET/HEAD).' },
          timeout_ms: { type: 'number', description: 'Default 30000, max 60000.' },
        },
        required: ['method', 'url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diff_request',
      description: 'Send the SAME request twice with two different header sets (e.g. two session cookies) and return only what differs — status/headers/body diff, not two full responses. Built for "logged in as user A vs B" / "authenticated vs not" checks: an IDENTICAL body across two different identities is the IDOR/BOLA signal. Refused if the host is outside this project\'s scope.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'GET, POST, PUT, PATCH, DELETE, ...' },
          url: { type: 'string', description: 'Full http:// or https:// URL.' },
          headers_a: { type: 'object', description: 'Headers for request A, e.g. {"Cookie": "session=userA..."}.' },
          headers_b: { type: 'object', description: 'Headers for request B, e.g. {"Cookie": "session=userB..."}.' },
          body: { type: 'string', description: 'Optional request body, sent identically to both A and B.' },
          timeout_ms: { type: 'number', description: 'Default 30000, max 60000.' },
        },
        required: ['method', 'url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finding',
      description: 'Track vulnerabilities found in this project (severity, evidence, repro steps) instead of leaving them scattered in chat. action=report generates a full markdown writeup from everything recorded — bounty usually dies at the report stage, not the finding stage.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"add" | "update_status" | "list" | "report".' },
          title: { type: 'string', description: 'add: short finding title.' },
          severity: { type: 'string', description: 'add: "critical" | "high" | "medium" | "low" | "info".' },
          description: { type: 'string', description: 'add: what the bug is and its impact.' },
          evidence: { type: 'string', description: 'add: repro steps, request/response, PoC.' },
          id: { type: 'string', description: 'update_status: finding id or prefix (shown by list).' },
          status: { type: 'string', description: 'update_status: "open" | "reported" | "fixed" | "wontfix" | "duplicate".' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'binary',
      description: 'Binary-safe file inspection for forensics/reverse/pwn — read_file assumes UTF-8 text and mangles anything else. info detects file type by magic bytes; hexdump shows raw bytes; strings extracts printable runs.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"info" | "hexdump" | "strings".' },
          path: { type: 'string', description: 'File path relative to the working directory.' },
          offset: { type: 'number', description: 'hexdump: byte offset to start at (default 0).' },
          length: { type: 'number', description: 'hexdump: bytes to show (default 512, max 8192).' },
          min_length: { type: 'number', description: 'strings: minimum run length to report (default 4).' },
        },
        required: ['action', 'path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ctf_board',
      description: 'Status board for parallel CTF challenges — what\'s solved, in progress, or stuck. Knowing when to give up on one and switch to another can save a whole competition; this makes that call visible instead of living only in chat scrollback.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"add" | "update" | "list".' },
          name: { type: 'string', description: 'add: challenge name.' },
          category: { type: 'string', description: 'add: e.g. "pwn", "crypto", "web", "forensics", "rev", "misc". Default "misc".' },
          points: { type: 'number', description: 'add: point value, if known.' },
          id: { type: 'string', description: 'update: challenge id or exact name.' },
          status: { type: 'string', description: 'update: "todo" | "in_progress" | "stuck" | "solved" | "skipped".' },
          notes: { type: 'string', description: 'update: progress notes / what\'s been tried.' },
          flag: { type: 'string', description: 'update: the captured flag — setting this also marks it solved.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recon',
      description: 'Subdomain recon monitoring for a project (crt.sh, free/keyless). Being first to see a new asset often matters more than a deeper bug on a known one. start_monitor runs only while this app stays open (in-app timer, not a service). add_target/scan refused if the domain is outside this project\'s scope (see the scope tool).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"add_target" | "remove_target" | "scan" | "list_targets" | "start_monitor" | "stop_monitor" | "monitor_status".' },
          domain: { type: 'string', description: 'Bare domain, e.g. "example.com". Required for add_target/remove_target/scan.' },
          interval_minutes: { type: 'number', description: 'start_monitor: default 30, min 5, max 1440.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scope',
      description: 'Authorized-target allowlist for this project (domain, "*.domain", IP, or CIDR). Empty = unrestricted. Non-empty = http_request and recon refuse any host that doesn\'t match. A legal rail, not a suggestion — set this before real bounty/pentest work.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"add" | "remove" | "list" | "clear".' },
          entry: { type: 'string', description: 'Required for add/remove, e.g. "example.com", "*.example.com", "10.0.0.0/24".' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_tools',
      description: 'Check which security tools are actually installed and on PATH (nmap, ffuf, nuclei, sqlmap, gdb, radare2, binwalk, volatility, pwntools, etc.) before assuming one is available. Does not install anything.',
      parameters: {
        type: 'object',
        properties: {
          names: { type: 'string', description: 'Comma-separated tool names to check. Omit to check the whole known list.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'parse_scan_output',
      description: 'Parse raw ffuf/nuclei/dalfox/sqlmap output (read it first with read_file/session/artifact) into a compact table instead of reading the raw JSON wall yourself. ffuf needs -of json, nuclei needs -jsonl, dalfox needs --format json, sqlmap reads its normal log text for "Parameter:" blocks. For wordlists, point ffuf/dalfox at a local SecLists path if the user has one, or use web_fetch to pull one from the SecLists GitHub repo.',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: '"ffuf" | "nuclei" | "dalfox" | "sqlmap".' },
          content: { type: 'string', description: 'The raw output content to parse.' },
        },
        required: ['tool', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codec',
      description: 'Instant encode/decode: base64, base32, hex, url, rot13, morse, binary. No shell roundtrip. rot13 ignores operation (self-inverse).',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', description: '"encode" or "decode".' },
          format: { type: 'string', description: 'base64 | base32 | hex | url | rot13 | morse | binary.' },
          text: { type: 'string', description: 'Text to transform.' },
        },
        required: ['operation', 'format', 'text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_file_preview',
      description: 'Show a project file to the user in a side panel. Also returns its content, same as read_file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_web_preview',
      description: 'Show a URL live to the user in a docked mini-browser panel.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full http:// or https:// URL.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
] as const;

// Only offered when Full Control is ON (electron/store.ts fullControl) — no path/folder scoping
// and no approval step by design; see electron/tools.ts computer_*/session_* implementations.
export const COMPUTER_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'computer_screenshot',
      description: 'Screenshot the current screen (Windows), shown inline to the user. Downscaled JPEG with a scale-factor label strip at the bottom (screen coords = image coords × that factor; strip itself is not screen content).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_click',
      description: 'Move the mouse to absolute screen pixel coordinates and click.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X pixels.' },
          y: { type: 'number', description: 'Y pixels.' },
          button: { type: 'string', description: '"left" (default), "right", or "double".' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_type',
      description: 'Type literal text at the current keyboard focus.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Literal text to type.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_key',
      description: 'Press a key/combo, e.g. "enter", "esc", "ctrl+c", "alt+tab", "win+d", "f5".',
      parameters: {
        type: 'object',
        properties: {
          keys: { type: 'string', description: 'Key or combo.' },
        },
        required: ['keys'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'restart_app',
      description: 'Relaunch this app from the same install path. Only after editing+rebuilding this app\'s own source (npm run build / dist:win). Never for any other reason.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'session',
      description: 'A persistent interactive process (shell, "nc host port", python3, sqlmap, gdb, msfconsole...) for back-and-forth, unlike one-shot run_command. Plain stdio pipes, not a real TTY. Max 6 open at once — close when done.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"open" | "write" | "read" | "close" | "list".' },
          command: { type: 'string', description: 'open: command that starts the process.' },
          cwd: { type: 'string', description: 'open: working directory relative to the project root. Default ".".' },
          session_id: { type: 'string', description: 'write/read/close: id returned by open.' },
          input: { type: 'string', description: 'write: text to send (newline added automatically).' },
          wait_ms: { type: 'number', description: 'write/read: default 1500, max 8000; read: 0 = immediately.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'webview_fill',
      description: 'Fill form fields by DOM selector inside the docked web preview panel (open it first with open_web_preview) — precise, not a coordinate guess like computer_click, and immune to the page shifting under a click (cookie banners, popups). Use the native input value setter internally so React/Vue-controlled fields register the change.',
      parameters: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            description: 'List of {selector, value} to fill, e.g. [{"selector":"#email","value":"a@b.com"}].',
            items: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'CSS selector for the input/textarea/select.' },
                value: { type: 'string', description: 'Value to set.' },
              },
              required: ['selector', 'value'],
              additionalProperties: false,
            },
          },
          submit_selector: { type: 'string', description: 'Optional CSS selector of a button/element to click after filling, e.g. "button[type=submit]".' },
        },
        required: ['fields'],
        additionalProperties: false,
      },
    },
  },
] as const;

export const ALL_TOOL_NAMES: string[] = [...TOOL_DEFINITIONS, ...COMPUTER_TOOL_DEFINITIONS].map((def) => def.function.name);

// What ships enabled out of the box: the tools that existed before this app grew a security
// toolkit (session/artifact/recon/scope/codec/http_request/diff_request/check_tools/
// parse_scan_output/finding/binary/ctf_board). Those cost real schema tokens on every request
// whether used or not, so they default OFF — turn on only what the current task needs.
export const DEFAULT_ENABLED_TOOLS: string[] = [
  'read_file', 'write_file', 'edit_file', 'list_directory', 'search_files', 'run_command',
  'web_fetch', 'web_search', 'open_file_preview', 'open_web_preview',
  'computer_screenshot', 'computer_click', 'computer_type', 'computer_key', 'restart_app', 'webview_fill',
];

export function getToolDefinitions(fullControl: boolean, enabledTools: readonly string[]) {
  const enabled = new Set(enabledTools);
  const base = TOOL_DEFINITIONS.filter((def) => enabled.has(def.function.name));
  if (!fullControl) return base;
  const computer = COMPUTER_TOOL_DEFINITIONS.filter((def) => enabled.has(def.function.name));
  return [...base, ...computer];
}

export interface ToolArgumentValidation {
  ok: boolean;
  args?: Record<string, unknown>;
  error?: string;
}

export function validateToolCallArguments(
  name: string,
  rawArguments: string,
  definitions: readonly { function: { name: string; parameters: any } }[] = TOOL_DEFINITIONS,
): ToolArgumentValidation {
  const definition = definitions.find((item) => item.function.name === name);
  if (!definition) {
    return { ok: false, error: `Unknown tool name: ${name || '(empty)'}.` };
  }

  let parsed: unknown;
  try {
    parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch (error) {
    return { ok: false, error: `Arguments are not valid JSON: ${(error as Error).message}` };
  }

  const errors: string[] = [];
  validateAgainstSchema(parsed, definition.function.parameters, '$', errors);
  if (errors.length > 0) {
    return { ok: false, error: errors.slice(0, 6).join('; ') };
  }
  return { ok: true, args: parsed as Record<string, unknown> };
}

function validateAgainstSchema(
  value: unknown,
  schema: {
    type?: string;
    properties?: Readonly<Record<string, { readonly type?: string }>>;
    required?: readonly string[];
    additionalProperties?: boolean;
  },
  location: string,
  errors: string[],
): void {
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${location} must be an object`);
      return;
    }
    const objectValue = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in objectValue)) errors.push(`${location}.${required} is required`);
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) {
        if (!(key in properties)) errors.push(`${location}.${key} is not allowed`);
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in objectValue)) continue;
      const propertyValue = objectValue[key];
      if (propertySchema.type === 'string' && typeof propertyValue !== 'string') {
        errors.push(`${location}.${key} must be a string`);
      } else if (propertySchema.type === 'number' && typeof propertyValue !== 'number') {
        errors.push(`${location}.${key} must be a number`);
      } else if (propertySchema.type === 'boolean' && typeof propertyValue !== 'boolean') {
        errors.push(`${location}.${key} must be a boolean`);
      }
    }
  }
}
