import fs from 'node:fs/promises';
import path from 'node:path';

function normalizeForCompare(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(root: string, target: string): boolean {
  const rootNorm = normalizeForCompare(root);
  const targetNorm = normalizeForCompare(target);
  return targetNorm === rootNorm || targetNorm.startsWith(`${rootNorm}${path.sep}`);
}

export async function resolveProjectPath(
  projectRoot: string,
  inputPath = '.',
  options: { allowMissing?: boolean; fullControl?: boolean } = {},
): Promise<string> {
  // Full-control mode: the user explicitly disabled folder scoping from the UI.
  // Resolve the path on the real filesystem (absolute paths allowed) with no
  // containment check at all.
  if (options.fullControl) {
    const candidate = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(projectRoot, inputPath);
    try {
      return await fs.realpath(candidate);
    } catch (error) {
      if (options.allowMissing) return candidate;
      throw error;
    }
  }

  const rootReal = await fs.realpath(projectRoot);

  // Tool paths are intentionally project-relative. Reject every absolute-path
  // flavor explicitly so validation behaves the same during tests on Linux
  // and in the packaged Windows app (drive-letter, UNC and POSIX paths).
  if (path.isAbsolute(inputPath) || path.win32.isAbsolute(inputPath) || /^\\\\/.test(inputPath)) {
    throw new Error('Path rejected: tool paths must be relative to the selected working directory.');
  }

  const candidate = path.resolve(rootReal, inputPath);

  if (!isInside(rootReal, candidate)) {
    throw new Error('Path rejected: target is outside the selected working directory.');
  }

  try {
    const targetReal = await fs.realpath(candidate);
    if (!isInside(rootReal, targetReal)) {
      throw new Error('Path rejected: symbolic link escapes the selected working directory.');
    }
    return targetReal;
  } catch (error) {
    if (!options.allowMissing) throw error;

    let ancestor = path.dirname(candidate);
    let ancestorReal: string | null = null;

    while (ancestorReal === null) {
      try {
        ancestorReal = await fs.realpath(ancestor);
      } catch (ancestorError) {
        const code = (ancestorError as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw ancestorError;
        const next = path.dirname(ancestor);
        if (next === ancestor) throw ancestorError;
        ancestor = next;
      }
    }

    if (!isInside(rootReal, ancestorReal)) {
      throw new Error('Path rejected: nearest existing parent escapes the selected working directory.');
    }
    return candidate;
  }
}

export function validateShellCommand(command: string, options: { fullControl?: boolean } = {}): void {
  if (!command.trim()) throw new Error('Command cannot be empty.');
  if (options.fullControl) {
    if (command.includes('\0')) throw new Error('Command contains an invalid NUL character.');
    if (command.length > 8_000) throw new Error('Command is too long.');
    return;
  }
  if (command.includes('\0')) throw new Error('Command contains an invalid NUL character.');
  if (command.length > 8_000) throw new Error('Command is too long.');

  const normalized = command.replace(/\r?\n/g, ' ');
  const bannedPatterns: Array<{ regex: RegExp; reason: string }> = [
    { regex: /\b(cd|chdir|pushd|popd|set-location)\b/i, reason: 'directory-changing commands are blocked' },
    { regex: /(^|[\s"'=])\.\.(?=$|[\s\\/"'])/, reason: 'parent-directory traversal is blocked' },
    { regex: /(?:^|[\s"'=])[a-zA-Z]:[\\/]/, reason: 'absolute Windows paths are blocked' },
    { regex: /(?:^|[\s"'=])\\(?!\\)[^\s]/, reason: 'root-relative Windows paths are blocked' },
    { regex: /\\\\[^\\]+\\[^\\]+/, reason: 'UNC/network paths are blocked' },
    { regex: /(?:^|[\s"'=])\/\/[^\s/]+\/[^\s/]+/i, reason: 'slash-form network paths are blocked' },
    { regex: /\\\\[?.]\\/i, reason: 'Windows device paths are blocked' },
    { regex: /(?:^|[\s"'])~[\\/]/, reason: 'home-directory shortcuts are blocked' },
    { regex: /%[A-Z_][A-Z0-9_]*%/i, reason: 'environment-variable path indirection is blocked' },
    { regex: /\$env:[A-Z_][A-Z0-9_]*\b/i, reason: 'PowerShell environment-variable path indirection is blocked' },
    { regex: /(?:^|[\s"'=])\$HOME\b/i, reason: 'PowerShell home-directory indirection is blocked' },
    { regex: /\[Environment\]::GetFolderPath\s*\(/i, reason: 'system-folder discovery is blocked' },
    { regex: /\b(file:\/\/)/i, reason: 'file URLs are blocked' },
    { regex: /\b(powershell|pwsh|cmd(?:\.exe)?|wsl|bash|sh)\b/i, reason: 'nested shell wrappers are blocked' },
    { regex: /\b(node|python(?:3)?|py)\b[^\r\n]*(?:\s-e\b|\s--eval\b|\s-c\b)/i, reason: 'inline interpreter code is blocked' },
    { regex: /\b(format|diskpart|bcdedit|shutdown|mountvol|subst|mklink)\b/i, reason: 'system-level command is blocked' },
    { regex: /\b(reg|reg\.exe)\s+(delete|add)\b/i, reason: 'registry mutation is blocked' },
  ];

  for (const item of bannedPatterns) {
    if (item.regex.test(normalized)) {
      throw new Error(`Command rejected: ${item.reason}.`);
    }
  }
}
