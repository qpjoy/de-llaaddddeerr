import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function windowsPowerShellCommand(): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  const candidates = systemRoot
    ? [
        join(systemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      ]
    : [];
  return candidates.find((candidate) => existsSync(candidate)) ?? 'powershell.exe';
}
