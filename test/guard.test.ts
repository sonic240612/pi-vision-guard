import test from "node:test";
import assert from "node:assert/strict";
import {
  extractChromeTargets,
  isScriptFilePath,
  sanitizeScriptText,
  sanitizeShellChromeCommand,
} from "../src/guard.ts";

test("rewrites SwiftShader and --disable-gpu on Windows bash Chrome command", () => {
  const input =
    `"$CHROME" --headless=new --disable-gpu --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --remote-debugging-port=9333 about:blank`;
  const res = sanitizeShellChromeCommand(input, "win32");
  assert.equal(res.changed, true);
  assert.doesNotMatch(res.command, /--disable-gpu/);
  assert.doesNotMatch(res.command, /swiftshader/i);
  assert.match(res.command, /--use-gl=angle/);
  assert.match(res.command, /--use-angle=d3d11/);
  assert.match(res.command, /--ignore-gpu-blocklist/);
  assert.match(res.command, /--remote-debugging-port=9333/);
});

test("does not inject duplicate GPU flags when d3d11 is already present", () => {
  const input =
    `chrome.exe --headless=new --use-gl=angle --use-angle=d3d11 --ignore-gpu-blocklist http://127.0.0.1:8080`;
  const res = sanitizeShellChromeCommand(input, "win32");
  assert.equal(res.changed, false);
  assert.equal(res.command, input);
});

test("strips --remote-debugging-port when combined with one-shot --screenshot", () => {
  const input =
    `chrome.exe --headless=new --use-gl=angle --use-angle=d3d11 --remote-debugging-port=50400 --screenshot=shot.png http://127.0.0.1:8080`;
  const res = sanitizeShellChromeCommand(input, "win32");
  assert.equal(res.changed, true);
  assert.doesNotMatch(res.command, /--remote-debugging-port/);
  assert.match(res.command, /--screenshot=shot\.png/);
});

test("rewrites pkill -f targeting remote-debugging-port using safe EncodedCommand", () => {
  const input = `node shot.mjs; pkill -f "remote-debugging-port=9333" 2>/dev/null`;
  const res = sanitizeShellChromeCommand(input, "win32");
  assert.equal(res.changed, true);
  assert.doesNotMatch(res.command, /\bpkill\b/);
  assert.match(res.command, /powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+/);

  const encodedMatch = res.command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/);
  assert.ok(encodedMatch?.[1]);
  const decoded = Buffer.from(encodedMatch[1], "base64").toString("utf16le");
  assert.match(decoded, /remote-debugging-port=9333/);
  assert.match(decoded, /Stop-Process/);
});

test("ignores non-browser grep/rg commands, unrelated pkill, and non-Windows platforms", () => {
  const grepCmd = `rg --disable-gpu --use-angle=swiftshader src/`;
  assert.equal(sanitizeShellChromeCommand(grepCmd, "win32").changed, false);

  const unrelatedPkill = `pkill -f "my-custom-worker"`;
  assert.equal(sanitizeShellChromeCommand(unrelatedPkill, "win32").changed, false);

  const linuxCmd = `google-chrome --headless=new --disable-gpu --use-angle=swiftshader http://localhost:3000`;
  assert.equal(sanitizeShellChromeCommand(linuxCmd, "linux").changed, false);
});

test("sanitizes JS automation scripts without breaking array syntax and skips Markdown docs", () => {
  assert.equal(isScriptFilePath("shot.mjs"), true);
  assert.equal(isScriptFilePath("capture.py"), true);
  assert.equal(isScriptFilePath("README.md"), false);
  assert.equal(isScriptFilePath("AGENTS.md"), false);

  const script = `const args = ['--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];`;
  const res = sanitizeScriptText(script, "win32");
  assert.equal(res.changed, true);
  assert.doesNotMatch(res.content, /--disable-gpu/);
  assert.doesNotMatch(res.content, /swiftshader/);
  assert.match(res.content, /'--use-angle=d3d11'/);
  assert.match(res.content, /'--ignore-gpu-blocklist'/);
});

test("extracts debugging ports and user-data-dir paths", () => {
  const targets = extractChromeTargets(
    `chrome --remote-debugging-port=9333 --user-data-dir="C:\\temp\\app\\.chr"`,
  );
  assert.deepEqual(targets.ports, ["9333"]);
  assert.deepEqual(targets.dirs, ["C:/temp/app/.chr"]);
});
