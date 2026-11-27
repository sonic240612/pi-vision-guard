export interface RewriteResult {
  changed: boolean;
  notes: string[];
}

export interface ShellRewriteResult extends RewriteResult {
  command: string;
}

export interface ScriptRewriteResult extends RewriteResult {
  content: string;
}

export interface ExtractedTargets {
  ports: string[];
  dirs: string[];
}

const SCRIPT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
]);

export const WINDOWS_CHROME_SYSTEM_HINT = [
  "",
  "## Browser / Screenshot Rules (pi-vision-guard)",
  "- When running headless Chrome/Chromium on Windows for screenshots or WebGL inspection, ALWAYS pass `--headless=new --use-gl=angle --use-angle=d3d11 --ignore-gpu-blocklist` (NEVER `--disable-gpu`, `--use-angle=swiftshader`, or `--enable-unsafe-swiftshader`).",
  "- Do NOT combine `--screenshot=...` with `--remote-debugging-port=...` on one Chrome invocation (that keeps headless Chrome open until timeout). Use either one-shot `--screenshot=...` alone, or CDP with explicit `Browser.close`.",
  "- Do NOT create numbered per-run `--user-data-dir` folders inside the workspace (such as `.cp9350` or `.chrome-profile-*`). Reuse ONE folder under OS temp (e.g. `$env:TEMP\\pi-chrome-profile`) or delete the temp profile right after Chrome exits.",
  "- On Windows, do NOT use `pkill -f` to stop `chrome.exe` or local Python servers (Git Bash `pkill` skips native Windows processes). Kill exact PIDs with `Stop-Process` or `taskkill`.",
].join("\n");

/**
 * Extracts `--remote-debugging-port` values and `--user-data-dir` paths from a command or script
 * so end-of-run cleanup only terminates headless Chrome instances associated with the session.
 */
export function extractChromeTargets(text: string): ExtractedTargets {
  const ports = new Set<string>();
  const dirs = new Set<string>();

  for (const m of text.matchAll(/--remote-debugging-port(?:=|\s+)(\d{2,5})/gi)) {
    if (m[1]) ports.add(m[1]);
  }
  for (const m of text.matchAll(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s;|&,'"\]]+))/gi)) {
    const raw = m[1] || m[2] || m[3];
    if (raw) dirs.add(raw.replace(/\\/g, "/"));
  }

  return { ports: Array.from(ports), dirs: Array.from(dirs) };
}

/**
 * Returns true for code/script paths where Chrome launch flags can safely be rewritten,
 * skipping documentation/data files (e.g., `.md`, `.json`, `.txt`).
 */
export function isScriptFilePath(filePath: unknown): boolean {
  if (typeof filePath !== "string" || !filePath.trim()) return false;
  const clean = filePath.trim().toLowerCase();
  const base = clean.split(/[\\/]/).pop() ?? "";
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx === -1) return true;
  return SCRIPT_EXTENSIONS.has(base.slice(dotIdx));
}

function buildWindowsChromeStopCommand(portHint?: string): string {
  // Use base64 -EncodedCommand so the command executes identically from Git Bash, cmd, or PowerShell
  // without quoting/escaping drift or interpolating arbitrary shell text.
  const portFilter = portHint
    ? ` -and $_.CommandLine -match 'remote-debugging-port=${portHint}'`
    : ` -and $_.CommandLine -match '--remote-debugging-port='`;
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.CommandLine -match '--headless'${portFilter} } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

/**
 * Rewrites unsafe headless Chrome flags and ineffective Windows `pkill` commands in shell strings.
 */
export function sanitizeShellChromeCommand(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
): ShellRewriteResult {
  let out = cmd;
  const notes: string[] = [];

  // Only treat as a browser invocation when an actual Chrome/Edge binary/driver token or --headless
  // browser CLI signature appears, avoiding accidental edits to grep/rg/git commands.
  const isBrowserInvocation =
    /(?:chrome(?:\.exe)?|chromium|msedge(?:\.exe)?|google-chrome|puppeteer|playwright|\$CHROME)/i.test(out) ||
    /--headless(?:=(?:new|old))?\b[^\n]*--(?:disable-gpu|use-angle|use-gl|remote-debugging-port|screenshot)/i.test(
      out,
    );

  if (isBrowserInvocation) {
    if (/--screenshot(?:=|\s)/i.test(out) && /--remote-debugging-port(?:=|\s)+\d+/i.test(out)) {
      out = out.replace(/(^|\s)--remote-debugging-port(?:=|\s)+\d+(?=\s|$|;|'|")/gi, "$1");
      notes.push("removed --remote-debugging-port incompatible with one-shot --screenshot");
    }

    if (platform === "win32") {
      const hadBadGpuFlag =
        /--disable-gpu\b|--use-angle=swiftshader(?:-webgl)?\b|--use-gl=swiftshader\b|--enable-unsafe-swiftshader\b/i.test(
          out,
        );
      const hadHeadless = /--headless(?:=(?:new|old))?\b/i.test(out);

      if (hadBadGpuFlag) {
        out = out.replace(/(^|\s)--disable-gpu(?=\s|$|;|'|")/gi, "$1");
        out = out.replace(/(^|\s)--use-angle=swiftshader(?:-webgl)?(?=\s|$|;|'|")/gi, "$1");
        out = out.replace(/(^|\s)--use-gl=swiftshader(?=\s|$|;|'|")/gi, "$1");
        out = out.replace(/(^|\s)--enable-unsafe-swiftshader(?=\s|$|;|'|")/gi, "$1");
        notes.push("removed --disable-gpu / swiftshader flags");
      }

      if ((hadBadGpuFlag || hadHeadless) && !/--use-angle=d3d11\b/i.test(out) && /--headless/i.test(out)) {
        const gpuFlags: string[] = [];
        if (!/--use-gl=/i.test(out)) gpuFlags.push("--use-gl=angle");
        if (!/--use-angle=/i.test(out)) gpuFlags.push("--use-angle=d3d11");
        if (!/--ignore-gpu-blocklist\b/i.test(out)) gpuFlags.push("--ignore-gpu-blocklist");
        if (gpuFlags.length > 0) {
          out = out.replace(/(--headless(?:=(?:new|old))?\b)/i, `$1 ${gpuFlags.join(" ")}`);
          notes.push(`injected ${gpuFlags.join(" ")}`);
        }
      }
    }
  }

  if (platform === "win32" && /\bpkill\b/i.test(out)) {
    const pkillRe = /\bpkill\b(?:\s+-[a-zA-Z0-9]+)*(?:\s+(?:"[^"]*"|'[^']*'|\S+))?/gi;
    out = out.replace(pkillRe, (match) => {
      if (!/(chrome|headless|remote-debugging-port|--user-data-dir)/i.test(match)) {
        return match;
      }
      const portMatch = match.match(/remote-debugging-port=(\d{2,5})/i);
      notes.push("replaced Chrome pkill with Windows Stop-Process cleanup");
      return buildWindowsChromeStopCommand(portMatch?.[1]);
    });
  }

  out = out.replace(/ {2,}/g, " ");
  return { command: out, changed: notes.length > 0 && out !== cmd, notes };
}

/**
 * Rewrites unsafe Chrome launch args inside written or edited automation scripts (`.js`, `.py`, `.sh`, etc.)
 * while preserving array/string syntax.
 */
export function sanitizeScriptText(
  text: string,
  platform: NodeJS.Platform = process.platform,
): ScriptRewriteResult {
  if (platform !== "win32") {
    return { content: text, changed: false, notes: [] };
  }
  if (!/(chrome|puppeteer|playwright|chromium|--headless|--use-angle|swiftshader)/i.test(text)) {
    return { content: text, changed: false, notes: [] };
  }

  let out = text;
  const notes: string[] = [];

  if (/--use-angle=swiftshader(?:-webgl)?/i.test(out)) {
    out = out.replace(/--use-angle=swiftshader(?:-webgl)?/gi, "--use-angle=d3d11");
    notes.push("script: swiftshader -> d3d11");
  }
  if (/--use-gl=swiftshader/i.test(out)) {
    out = out.replace(/--use-gl=swiftshader/gi, "--use-gl=angle");
    notes.push("script: use-gl=swiftshader -> angle");
  }
  if (/--enable-unsafe-swiftshader/i.test(out)) {
    out = out.replace(/--enable-unsafe-swiftshader/gi, "--ignore-gpu-blocklist");
    notes.push("script: enable-unsafe-swiftshader -> ignore-gpu-blocklist");
  }
  if (/--disable-gpu\b/i.test(out)) {
    // Keep array elements syntactically valid when inside `['--headless', '--disable-gpu']`.
    const replacement = /--use-gl=/i.test(out) ? "--ignore-gpu-blocklist" : "--use-gl=angle";
    out = out.replace(/--disable-gpu\b/gi, replacement);
    notes.push(`script: disable-gpu -> ${replacement}`);
  }
  if (/pkill\s+-f[^\n"'`]*(chrome|remote-debugging-port|headless)/i.test(out)) {
    out = out.replace(
      /pkill\s+-f\s+(?:"([^"]*)"|'([^']*)'|(\S+))/gi,
      (full, q1: string | undefined, q2: string | undefined, q3: string | undefined) => {
        const arg = q1 ?? q2 ?? q3 ?? "";
        if (!/(chrome|remote-debugging-port|headless)/i.test(arg)) return full;
        const portMatch = arg.match(/remote-debugging-port=(\d{2,5})/i);
        notes.push("script: replaced Chrome pkill -f with Stop-Process");
        return buildWindowsChromeStopCommand(portMatch?.[1]);
      },
    );
  }

  return { content: out, changed: notes.length > 0 && out !== text, notes };
}
