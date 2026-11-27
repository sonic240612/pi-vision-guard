# pi-vision-guard

A [Pi](https://github.com/earendil-works/pi) extension package that prevents local LLM coding/vision agents from stalling CPU-assisted local inference when driving headless Chrome/Chromium on Windows.

## Target Environment

This extension was designed and verified on the following single-workstation local LLM setup:

| Component | Specification |
| --- | --- |
| **OS** | Windows 11 Education (`10.0.26200`) |
| **CPU** | AMD Ryzen 5 7500F (6 cores / 12 threads, shared between Windows, browser automation, and Strata's 5-worker + 1-host CPU expert pool) |
| **RAM** | 64 GiB DDR5-5600 (`63.6 GiB` usable; `46.84 GiB` locked expert arena) |
| **GPU** | NVIDIA GeForce RTX 3090 (`24 GiB` VRAM, `sm_86`, Driver `610.88`, PCIe `~26.3–26.8 GB/s`) |
| **Local Inference** | [Strata](https://github.com/Niko1221/Strata) (`0.2.20` / engine `0.1.66`), `Qwen3.8-Flash-Next IQ3_S` + GPU Vision (`strata-vision.exe`, `719 MiB` VRAM, `--vram-reserve-mib 1024 --pcie-frac 0.35 --adapt-async 1`, `STRATA_WIN_PRIORITY=above_normal`) |
| **Agent Client** | `pi` (`@earendil-works/pi-coding-agent`) connected to a local OpenAI-compatible endpoint (`http://127.0.0.1:8080/v1`) |

> Note: On hybrid CPU+GPU MoE inference engines (where cold experts and async swaps run across a 6-core CPU pool while the GPU holds hot experts), anything that saturates CPU cores outside the engine directly slows down token generation.

## Why This Was Built (Observed Failures & Measurements)

While inspecting generated WebGL / Three.js pages (`233,520` triangles) through headless Chrome screenshots with a local coding agent, four concrete failure modes showed up:

1. **SwiftShader CPU starvation (`97.8 tok/s` → `11.3–16.9 tok/s`)**:
   Models routinely launch headless Chrome with `--disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader`. On Windows, software WebGL (`SwiftShader`) pushed `chrome.exe` CPU usage to **`92.1%`** (versus **`5.2%`** with `--use-gl=angle --use-angle=d3d11 --ignore-gpu-blocklist` and **`0.4%`** after navigating to `about:blank`). When left running behind Strata baseline execution, async adaptive rounds degraded (`24.0 ms` → `107.3 ms`) and decode speed collapsed from **`97.8 tok/s`** down to **`11.3–16.9 tok/s`**.
2. **Silent `pkill -f` failures in Windows Git Bash**:
   Models clean up background Chrome using `pkill -f "remote-debugging-port=..."`. Under Windows Git Bash, `pkill -f` ignores native `chrome.exe` processes, leaving WebGL `requestAnimationFrame` loops spinning at **`84–96%` CPU** even after the vision step finishes.
3. **Hanging `--screenshot` + `--remote-debugging-port` invocations**:
   Passing both `--screenshot=...` and `--remote-debugging-port=...` on one `chrome.exe --headless=new` command caused Chrome to remain open instead of exiting after writing the PNG, hitting the **180 s tool timeout** and leaving **3 orphaned Chrome processes** in baseline testing.
4. **Silent vision drop when `models.json` omits `"image"`**:
   Pi's `read` tool and OpenAI-compatible request builder only attach `image_url` blocks when the active model's `"input"` array includes `"image"`. If a local endpoint is configured with `"input": ["text"]`, screenshots never reach `strata-vision`.

### Measured Result with `pi-vision-guard`

In live local verification against Strata (`Qwen3.8-Flash-Next IQ3_S`):
- Enforcing D3D11 ANGLE + clean screenshot exit completed in `147.2 s` (`rc=0`), confirmed `Renderer: ANGLE (NVIDIA, NVIDIA GeForce RTX 3090 ... Direct3D11 ...)` in WebGL, left **`0` orphaned `chrome.exe` processes (`0.0%` CPU)**, and sustained **`95.5–139.1 tok/s`** across 20 agent turns (up to `20,261` context tokens).
- In an adversarial hook test explicitly passing `--disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader` without cleanup, `tool_call(bash)` rewrote flags in-place to D3D11 ANGLE and `agent_end` terminated the lingering headless Chrome processes.

## What `pi-vision-guard` Does

- **Prompt guidance (`before_agent_start`)**: Injects concise Windows GPU ANGLE (`--use-gl=angle --use-angle=d3d11 --ignore-gpu-blocklist`) and process cleanup rules when running on Windows.
- **Pre-execution sanitization (`tool_call`)**:
  - Rewrites `bash` / `powershell` browser commands to strip `--disable-gpu` / SwiftShader flags and inject D3D11 ANGLE flags (ignores non-browser search commands like `rg --disable-gpu`).
  - Strips `--remote-debugging-port=...` when paired with `--screenshot=...`.
  - Replaces Chrome-targeted `pkill -f` on Windows with a PowerShell `-EncodedCommand` `Stop-Process` call scoped to headless debugging Chrome processes.
  - Rewrites Chrome flags inside code/script files (`.js`, `.mjs`, `.ts`, `.py`, `.sh`, `.ps1`, etc.) created/edited via `write`/`edit`, while leaving documentation (`.md`, `.txt`, `.json`) untouched.
- **Orphan & temp-profile sweep (`agent_end` & `session_shutdown`)**:
  - Terminates leftover `--headless` `chrome.exe` processes strictly scoped to the session's tracked debugging ports, profile directories, or working directory (passing paths via environment variables to avoid PowerShell quoting injection), without touching interactive desktop Chrome or unrelated browser tools.
  - Safely removes unused disposable headless Chrome `--user-data-dir` folders (`.cp<port>`, `.chrome-profile-*`, `.chr*` containing Chrome `Local State` / `Default` signatures) after Chrome exits, preventing multi-gigabyte disk bloat across long runs while skipping active or custom persistent profiles.
- **Status & vision check (`/vision-guard`)**: Displays active platform, rewrite count, swept PIDs, log path, and warns when a local provider in `models.json` lacks `"image"` in `"input"`.

## Installation

### From GitHub

```bash
pi install git:github.com/sonic240612/pi-vision-guard
```

### From Local Checkout

```bash
git clone https://github.com/sonic240612/pi-vision-guard.git
pi install ./pi-vision-guard
```

Or run once without installing:

```bash
pi -e ./pi-vision-guard/index.ts
```

## Notes for Local Vision Endpoints (`models.json`)

Add `"image"` to `"input"` for multimodal local models in `~/.pi/agent/models.json`:

```json
"input": ["text", "image"]
```

Without `"image"`, Pi's `read` tool flags the model as text-only and strips the image payload before calling your local server.

## Configuration & Logs

- Log file defaults to `~/.pi/agent/logs/pi-vision-guard.log` (keeps project repositories free of untracked log files).
- Override via `PI_VISION_GUARD_LOG=/path/to/file.log`, or disable with `PI_VISION_GUARD_LOG=off`.
- Set `PI_VISION_GUARD_KEEP_PROFILES=1` to keep disposable headless Chrome profile directories (`.cp*`, `.chrome-profile-*`) for manual inspection.

## Development

```bash
npm install
npm run check
npm test
```

## License

MIT
