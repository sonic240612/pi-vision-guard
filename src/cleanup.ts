import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CleanupOptions {
  cwd: string;
  ports: ReadonlySet<string>;
  dirs: ReadonlySet<string>;
  reason: string;
  logPath?: string;
}

export interface CleanupResult {
  killedPids: string[];
  rawOutput: string;
}

// 100% static PowerShell script: dynamic session inputs are passed exclusively via environment
// variables (PI_VG_CWD, PI_VG_PORTS, PI_VG_DIRS) to prevent command/quote injection.
const STATIC_CLEANUP_PS = `
$cwdNorm = ($env:PI_VG_CWD + '') -replace '\\\\', '/'
$ports = @()
if ($env:PI_VG_PORTS) {
  $ports = $env:PI_VG_PORTS -split "\`n" | Where-Object { $_ -match '^\\d{2,5}$' }
}
$dirs = @()
if ($env:PI_VG_DIRS) {
  $dirs = ($env:PI_VG_DIRS -split "\`n") | ForEach-Object { ($_ -replace '\\\\', '/').Trim() } | Where-Object { $_.Length -gt 3 }
}

if (-not $ports.Count -and -not $dirs.Count -and $cwdNorm.Length -le 3) {
  Write-Output "KILLED:NONE"
  exit 0
}

$killed = @()
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  $cmd = $_.CommandLine
  if (-not $cmd) { return }
  if ($cmd -notmatch '--headless') { return }
  $cmdNorm = $cmd -replace '\\\\', '/'
  $match = $false

  foreach ($p in $ports) {
    if ($cmd -match ("--remote-debugging-port=" + $p + "\\b")) { $match = $true; break }
  }
  if (-not $match) {
    foreach ($d in $dirs) {
      if ($cmdNorm.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $match = $true; break }
    }
  }
  if (-not $match -and $cwdNorm.Length -gt 3) {
    $match = $cmdNorm.IndexOf($cwdNorm, [StringComparison]::OrdinalIgnoreCase) -ge 0
  }

  if ($match) {
    $pidVal = $_.ProcessId
    Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue
    $killed += "$pidVal"
  }
}
if ($killed.Count -gt 0) { Write-Output ("KILLED:" + ($killed -join ",")) } else { Write-Output "KILLED:NONE" }
`;

const ENCODED_CLEANUP_PS = Buffer.from(STATIC_CLEANUP_PS, "utf16le").toString("base64");

/**
 * Resolves the extension log file outside user repositories so `git status` stays clean.
 * Set `PI_VISION_GUARD_LOG=off` (or `0`/`none`) to disable file logging.
 */
export function resolveLogPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.PI_VISION_GUARD_LOG?.trim();
  if (override) {
    if (/^(off|0|false|none)$/i.test(override)) return undefined;
    return override;
  }
  return path.join(os.homedir(), ".pi", "agent", "logs", "pi-vision-guard.log");
}

export function appendGuardLog(logPath: string | undefined, message: string): void {
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Logging is best-effort and must never interrupt agent runs.
  }
}

/**
 * Terminates leftover headless `chrome.exe` processes launched by this session.
 * Requires `--headless` AND an exact match on session-tracked debugging ports, profile directories,
 * or working directory — never kills interactive desktop Chrome or unrelated headless tools.
 */
export function cleanupOrphanedHeadlessChrome(opts: CleanupOptions): CleanupResult {
  if (process.platform !== "win32") {
    return { killedPids: [], rawOutput: "SKIPPED_NON_WIN32" };
  }

  const normCwd = (opts.cwd || "").replace(/\\/g, "/");
  const portsValue = Array.from(opts.ports).filter((p) => /^\d{2,5}$/.test(p)).join("\n");
  const dirsValue = Array.from(opts.dirs).map((d) => d.replace(/[\r\n]/g, "")).join("\n");

  if (!portsValue && !dirsValue && normCwd.length <= 3) {
    return { killedPids: [], rawOutput: "KILLED:NONE" };
  }

  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_CLEANUP_PS],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      env: {
        ...process.env,
        PI_VG_CWD: normCwd,
        PI_VG_PORTS: portsValue,
        PI_VG_DIRS: dirsValue,
      },
    },
  );

  const stdout = (res.stdout || "").trim();
  const killedMatch = stdout.match(/^KILLED:(.+)$/m);
  const killedPids =
    killedMatch?.[1] && killedMatch[1] !== "NONE"
      ? killedMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
      : [];

  const summary = stdout || `rc=${res.status ?? "unknown"}`;
  appendGuardLog(opts.logPath, `cleanup(${opts.reason}) -> ${summary}`);
  return { killedPids, rawOutput: summary };
}
