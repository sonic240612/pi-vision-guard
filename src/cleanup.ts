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
  keepProfiles?: boolean;
}

export interface CleanupResult {
  killedPids: string[];
  removedProfiles: string[];
  rawOutput: string;
}

// 100% static PowerShell script: dynamic session inputs are passed exclusively via environment
// variables (PI_VG_CWD, PI_VG_PORTS, PI_VG_DIRS) to prevent command/quote injection.
// Emits KILLED:... and ACTIVE:... lines for any remaining chrome.exe CommandLines so profile
// cleanup never deletes a directory still used by a live Chrome process.
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

$killed = @()
$activeCmds = @()
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  $cmd = $_.CommandLine
  if (-not $cmd) { return }
  $cmdNorm = $cmd -replace '\\\\', '/'
  $shouldKill = $false

  if ($cmd -match '--headless' -and ($ports.Count -gt 0 -or $dirs.Count -gt 0 -or $cwdNorm.Length -gt 3)) {
    foreach ($p in $ports) {
      if ($cmd -match ("--remote-debugging-port=" + $p + "\\b")) { $shouldKill = $true; break }
    }
    if (-not $shouldKill) {
      foreach ($d in $dirs) {
        if ($cmdNorm.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $shouldKill = $true; break }
      }
    }
    if (-not $shouldKill -and $cwdNorm.Length -gt 3) {
      $shouldKill = $cmdNorm.IndexOf($cwdNorm, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
  }

  if ($shouldKill) {
    $pidVal = $_.ProcessId
    Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue
    $killed += "$pidVal"
  } else {
    $activeCmds += $cmdNorm
  }
}

if ($killed.Count -gt 0) { Write-Output ("KILLED:" + ($killed -join ",")) } else { Write-Output "KILLED:NONE" }
foreach ($ac in $activeCmds) {
  Write-Output ("ACTIVE:" + $ac)
}
`;

const ENCODED_CLEANUP_PS = Buffer.from(STATIC_CLEANUP_PS, "utf16le").toString("base64");

// Strict basename allowlist for ephemeral headless Chrome profile directories (`.cp9353`, `.chrome-profile-9351`, `.chr-hook`, etc.)
const EPHEMERAL_PROFILE_NAME_RE =
  /^\.(?:cp\d{2,5}|chrome-profile(?:-[\w.-]+)?|chrome-tmp(?:-[\w.-]+)?|headless-profile(?:-[\w.-]+)?|chr(?:-[\w.-]+|\d*)?)$/i;

const TEMP_EPHEMERAL_NAME_RE = /(?:chrome|chromium|headless|^cp\d|^chr)/i;

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
 * Checks whether `dirPath` looks like an actual Chrome user-data-dir (contains `Local State` or `Default`)
 * and is a safe, non-symlink disposable profile folder rather than an arbitrary project directory.
 */
export function isDisposableChromeProfileDir(
  dirPath: string,
  tmpRoot: string = os.tmpdir(),
): boolean {
  try {
    const stat = fs.lstatSync(dirPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  } catch {
    return false;
  }

  const resolved = path.resolve(dirPath);
  const norm = resolved.replace(/\\/g, "/");
  if (/\/appdata\/local\/google\/chrome\/user data(?:\/|$)/i.test(norm)) {
    return false;
  }

  const base = path.basename(resolved);
  const resolvedTmp = path.resolve(tmpRoot);
  const inTmp =
    resolved.toLowerCase().startsWith((resolvedTmp + path.sep).toLowerCase()) &&
    resolved.length > resolvedTmp.length + 1;

  const nameMatches =
    EPHEMERAL_PROFILE_NAME_RE.test(base) || (inTmp && TEMP_EPHEMERAL_NAME_RE.test(base));
  if (!nameMatches) return false;

  return (
    fs.existsSync(path.join(resolved, "Local State")) ||
    fs.existsSync(path.join(resolved, "Default"))
  );
}

/**
 * Finds and deletes unused ephemeral headless Chrome profile directories under `cwd` and `trackedDirs`.
 * Skips any directory referenced in `activeChromeCmds` or unless Chrome profile signatures exist.
 */
export function sweepDisposableChromeProfiles(opts: {
  cwd: string;
  trackedDirs: ReadonlySet<string>;
  activeChromeCmds: readonly string[];
  tmpRoot?: string;
}): string[] {
  const candidates = new Set<string>();
  const tmpRoot = opts.tmpRoot ?? os.tmpdir();

  for (const d of opts.trackedDirs) {
    if (d) candidates.add(path.resolve(d));
  }

  if (opts.cwd && opts.cwd.length > 3 && fs.existsSync(opts.cwd)) {
    try {
      for (const entry of fs.readdirSync(opts.cwd, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (EPHEMERAL_PROFILE_NAME_RE.test(entry.name)) {
          candidates.add(path.join(opts.cwd, entry.name));
        }
      }
    } catch {
      // Best-effort directory scan.
    }
  }

  const activeLower = opts.activeChromeCmds.map((c) => c.replace(/\\/g, "/").toLowerCase());
  const removed: string[] = [];

  for (const cand of candidates) {
    if (!isDisposableChromeProfileDir(cand, tmpRoot)) continue;
    const candNorm = cand.replace(/\\/g, "/").toLowerCase();
    const inUse = activeLower.some((cmd) => cmd.includes(candNorm));
    if (inUse) continue;

    try {
      fs.rmSync(cand, { recursive: true, force: true });
      removed.push(path.basename(cand));
    } catch {
      // Ignore locked/busy directories cleanly.
    }
  }

  return removed;
}

/**
 * Terminates leftover headless `chrome.exe` processes launched by this session and sweeps
 * unused disposable Chrome `--user-data-dir` profile folders created in `cwd` or OS temp.
 */
export function cleanupOrphanedHeadlessChrome(opts: CleanupOptions): CleanupResult {
  if (process.platform !== "win32") {
    return { killedPids: [], removedProfiles: [], rawOutput: "SKIPPED_NON_WIN32" };
  }

  const normCwd = (opts.cwd || "").replace(/\\/g, "/");
  const portsValue = Array.from(opts.ports).filter((p) => /^\d{2,5}$/.test(p)).join("\n");
  const dirsValue = Array.from(opts.dirs).map((d) => d.replace(/[\r\n]/g, "")).join("\n");

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
  const lines = stdout ? stdout.split(/\r?\n/) : [];
  const killedLine = lines.find((l) => l.startsWith("KILLED:")) ?? "";
  const killedVal = killedLine.slice("KILLED:".length).trim();
  const killedPids =
    killedVal && killedVal !== "NONE"
      ? killedVal.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

  const activeChromeCmds = lines
    .filter((l) => l.startsWith("ACTIVE:"))
    .map((l) => l.slice("ACTIVE:".length));

  const keepProfiles =
    opts.keepProfiles ?? /^(1|true|yes)$/i.test(process.env.PI_VISION_GUARD_KEEP_PROFILES ?? "");

  const removedProfiles = keepProfiles
    ? []
    : sweepDisposableChromeProfiles({
        cwd: opts.cwd,
        trackedDirs: opts.dirs,
        activeChromeCmds,
      });

  const killSummary = killedLine || `rc=${res.status ?? "unknown"}`;
  const profileSummary = removedProfiles.length > 0 ? removedProfiles.join(",") : "NONE";
  appendGuardLog(opts.logPath, `cleanup(${opts.reason}) -> ${killSummary} profiles=${profileSummary}`);

  return { killedPids, removedProfiles, rawOutput: `${killSummary} profiles=${profileSummary}` };
}
