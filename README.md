# Blender AXI

**Drive Blender from any shell-capable coding agent, without making Blender a permanent part of every context window.**

Blender AXI is an agent-facing CLI that speaks the unmodified stock [BlenderMCP v1.2](https://github.com/ahujasid/blender-mcp) addon's TCP protocol directly. There is no MCP server to register, no resident `uvx` process, and no patched addon. The interface appears only when an agent runs a command.

| Context | Results | Control |
| --- | --- | --- |
| **Zero resident tool-schema cost until invoked.** Compact [TOON](https://github.com/toon-format/toon) by default, JSON on request. | **One request can build, save, export, and render.** Failures include the actionable traceback and stdout printed before the exception. | **Sessions are explicit.** Named ports, opt-in launch, and session-owned stop behavior prevent silent fallback to another Blender. |

```sh
blender-axi ping
blender-axi scene
blender-axi build model.py \
  --save /tmp/model.blend \
  --glb /tmp/model.glb \
  --render front,side
```

> [!NOTE]
> In an independently verified, frozen four-cell Luna benchmark, Blender AXI completed **2/2 fully correct tasks with 2/2 valid required artifacts**; BlenderMCP completed **0/2 fully correct tasks with 0/2 valid required artifacts**. AXI used **394 s vs 702 s** total wall time, **104,113 vs 116,219** combined input and output tokens, and a **0.040729 vs 0.058815** provider-reported cost proxy. This was a controlled signal with one attempt per cell, not universal proof or a raw transport-speed test. [Read the result and full limitations](#frozen-luna-benchmark).

## Why a CLI

MCP tool schemas are resident context: they are presented at session start whether Blender is used or not. A CLI has no resident tool-schema cost. Agents already know how to invoke shell commands, so Blender AXI can spend its interface budget only when work reaches Blender.

The savings continue after invocation:

- **Compact by default.** Structured output uses TOON rather than brace-and-quote-heavy JSON. `scene` leads with aggregate counts; object rows are opt-in.
- **Work is composed before transport.** `build` wraps the supplied Python and requested save, GLB, render, and summary actions into one `execute_code` request.
- **Failures are complete.** `exec` and `build` return the exception, filtered Python traceback, and pre-failure stdout in the same response.
- **Chatty scripts stay bounded.** Stdout and failure detail longer than 1,500 characters are truncated with their total length and a `--full` recovery hint. Success keeps the head; failure output keeps the tail where the last progress line and failing frame usually live.
- **Connection intent is visible.** Ordinary commands never launch Blender. A named session never falls back to the default listener.

## How it works

```text
coding agent
    │  invokes only when Blender work is needed
    ▼
blender-axi CLI
    │  one JSON request over 127.0.0.1:<session-port>
    ▼
stock BlenderMCP v1.2 TCP listener
    │  execute_code inside the GUI Blender process
    ▼
user Python → save → GLB export → renders → scene summary
    │
    └─ TOON result, or JSON with --json
```

The CLI creates a fresh TCP connection per command and uses the addon's existing `get_scene_info` and `execute_code` messages. For Python execution it injects a small prelude that captures stdout and tracebacks, supplies common Blender globals, and re-resolves Blender context after `bpy.ops.wm.read_homefile()`. Save, export, render, and scene-summary steps then run sequentially inside the same addon request.

## Install

### Requirements

- Node.js 20 or newer
- Blender 3.2 or newer, running as a GUI application
- The unmodified stock BlenderMCP v1.2 `addon.py`

BlenderMCP declares Blender 3.0 as its minimum; Blender AXI requires 3.2 because its context recovery uses `bpy.context.temp_override`, introduced in Blender 3.2.

### Build from source

```sh
git clone https://github.com/vitalNohj/blender-axi.git
cd blender-axi
npm ci
npm run build
npm link
```

`npm link` makes `blender-axi` available on `PATH`. Without it, use `node dist/bin/blender-axi.js` from the repository.

> [!IMPORTANT]
> `blender-axi` is not currently published to npm. Do not use `npx blender-axi` for the CLI until a package is published; install from source and use the linked binary.

### Connect the stock addon

1. Download `addon.py` from [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp).
2. In Blender, choose **Edit > Preferences > Add-ons > Install...**, select `addon.py`, then enable **Interface: Blender MCP**.
3. In the 3D View, press <kbd>N</kbd> and open the **BlenderMCP** tab.
4. Leave the port at `9876` for the default session. For a named session, set the port reported by `blender-axi ping`; if the listener is already running, disconnect and reconnect it so the new port takes effect.
5. Start the listener with the sidebar's connect button. Stock v1.2 may auto-start the listener when the addon registers; the button is labeled **Connect to MCP server** in current `addon.py` and **Connect to Claude** in older setup instructions.

BlenderMCP refuses to start its listener in Blender background mode (`blender -b`), so use a GUI Blender process.

## Start here

Running the CLI with no arguments gives the same connection check as `ping`, plus the AXI home-view identity fields. It does not dump the full manual.

```console
$ blender-axi
bin: ~/.local/bin/blender-axi
description: "Drive Blender through its stock BlenderMCP TCP addon with isolated sessions, one-request builds, tracebacks, and camera renders."
ok: true
session: default
port: 9876
```

The first useful commands are deliberately small:

```sh
blender-axi ping          # confirm this session's listener
blender-axi scene         # inspect scene aggregates
blender-axi --help        # command index and examples
blender-axi build --help  # complete help for one command, no connection needed
```

### Inspect without flooding context

`scene` returns evaluated aggregate counts first:

```console
$ blender-axi scene
objects: 5
meshes: 3
triangles: 1248
materials: 2
collections: 1
name: Scene
help[1]: Run `blender-axi scene --full` to show all 5 objects
```

Request only the object columns needed for the next decision. Available fields are `name`, `type`, `visible`, `selected`, and `vertices`.

```console
$ blender-axi scene --fields name,type,vertices
objects: 3
meshes: 2
triangles: 84
materials: 1
collections: 1
name: Scene
items[3]{name,type,vertices}:
  Hull,MESH,48
  Mast,MESH,16
  Sun,LIGHT,null
```

Rows always include `name`, even when omitted from `--fields`. `--full` returns every object's `name,type` detail and wins over `--fields`.

### Execute Python with useful failure evidence

```sh
blender-axi exec script.py
cat script.py | blender-axi exec -
```

`run` is an alias for `exec`. Scripts start with `bpy`, `D` (`bpy.data`), `C` (`bpy.context`), and `_sc` (the active scene) resolved. Blender AXI removes its own wrapper frame and CPython caret-only decoration from tracebacks, leaving the frames the caller can act on.

```console
$ blender-axi exec broken.py
ok: false
error: "name 'bpu' is not defined"
stdout_before_failure: |
  starting build
traceback: |
  Traceback (most recent call last):
    File "/tmp/broken.py", line 2, in <module>
      bpu.ops.mesh.primitive_cube_add()
  NameError: name 'bpu' is not defined
```

### Build, save, export, and render in one request

```sh
blender-axi build model.py \
  --save /tmp/ship.blend \
  --glb /tmp/ship.glb \
  --render front,side
```

The script and requested actions are compiled into one socket request. Actions run in this order: **script → save → GLB export → renders → scene summary**.

```text
ok: true
stdout: |
  built hull
artifacts[4]: /tmp/ship.blend,/tmp/ship.glb,/tmp/render-front.png,/tmp/render-side.png
scene:
  objects: 4
  meshes: 2
  triangles: 96
  materials: 1
  collections: 1
```

`--save`, `--glb`, and `--render` are independent. Build renders are written beside `--save`, or in the current directory when there is no save path.

GLB export uses Blender's evaluated mesh, so modifiers such as bevels are baked into exported geometry without applying or removing the source modifier stack. A `.blend` saved before export remains editable. Blender documents that applying modifiers prevents shape-key export; objects without modifiers can still export shape keys as morph targets.

Build actions are sequential, not transactional. A save or export completed before a later failure can remain on disk even though the final response is a failure.

### Render for visual verification

```sh
blender-axi render front,side,back,tq \
  --out /tmp/renders \
  --res 880x1180
```

Angles are a comma-separated subset of `front`, `side`, `back`, and `tq` (three-quarter). The command orbits the scene camera around the midpoint between the lowest and highest mesh-object origin Z values. It creates a camera or sun light when missing. `--out` defaults to the current directory; without `--res`, the scene's existing resolution is retained.

## Output and artifact contract

TOON is the default output boundary. Add `--json` where a JSON envelope is more useful.

| Contract | Behavior |
| --- | --- |
| Exit `0` | Success, including idempotent lifecycle no-ops |
| Exit `1` | Connection, protocol, or Blender/Python execution failure |
| Exit `2` | Invalid command usage |
| `artifacts` | Only CLI-managed save, GLB, and render actions that all reached a successful response |
| Failed execution | `error`, `traceback`, and `stdout_before_failure`; no `artifacts` list |
| Long output | 1,500-character preview plus total length and a `--full` hint |

`exec` never tracks artifacts. Arbitrary Python used by `exec` or `build` may write files that Blender AXI cannot report. On a failed multi-action build, files written before the failure may exist even though `artifacts` is omitted.

Paths are passed to Blender as given. Prefer absolute paths outside the source tree, usually under `/tmp`, to avoid leaving `.blend`, `.glb`, and `.png` files in a repository.

## Sessions and lifecycle

Blender AXI resolves exactly one session and port. It never probes for another Blender and never silently falls back.

```sh
BLENDER_AXI_SESSION=worker-1 blender-axi ping
BLENDER_AXI_SESSION=worker-1 blender-axi build model.py \
  --save /tmp/worker-1.blend
```

The default session uses port `9876`. Named sessions hash deterministically to ports `9877` through `10876` and keep state under `~/.blender-axi/sessions/<name>/`. Hash collisions are possible within that 1,000-port range; use an explicit port to resolve one.

| Environment variable | Purpose |
| --- | --- |
| `BLENDER_AXI_SESSION` | Session name: 1-64 characters from `A-Za-z0-9._-`; names made only of dots are rejected |
| `BLENDER_AXI_PORT` | Explicit listener port from 1 to 65535; overrides session hashing |
| `BLENDER_AXI_BLENDER` | Executable used by `start` and `--launch`; defaults to `/Applications/Blender.app/Contents/MacOS/Blender` |

Set `BLENDER_AXI_BLENDER` explicitly on Linux and Windows. The addon's port must match the resolved session port. Changing the port in stock BlenderMCP does not rebind an already-running listener, so disconnect and reconnect after changing it.

Lifecycle changes require explicit intent:

- Ordinary `ping`, `scene`, `exec`, `build`, and `render` commands fail clearly when the selected port is unreachable.
- `--launch` lets one of those commands launch Blender only when its listener is unreachable.
- `start` returns `already-running` when the listener answers; otherwise it launches a detached GUI Blender, records its PID, and waits up to 30 seconds for the port.
- `stop` sends `SIGTERM` only to the PID recorded for the same session, then removes the PID file. Without a readable PID file it returns `not-owned` and sends no signal.

> [!CAUTION]
> A PID file proves what the session recorded, not what currently owns that operating-system PID. If a stale PID has been reused, `stop` could signal the wrong process. Remove or inspect stale state before stopping. Also treat `exec` and `build` scripts as trusted code: they execute arbitrary Python inside Blender through the addon's `execute_code` command.

## Agent integration

Both integration paths are optional. Install either one, both, or neither.

### Ambient session hooks

```sh
blender-axi setup hooks
```

This installs or repairs SessionStart integration for Claude Code, Codex, and OpenCode. The hook contributes compact live connection state when a supported agent session begins.

### On-demand packaged skill

[`skills/blender-axi/SKILL.md`](skills/blender-axi/SKILL.md) carries task-triggered guidance with no per-session cost until an agent loads it:

```sh
npx skills add vitalNohj/blender-axi --skill blender-axi
```

The skill currently renders command examples as `npx -y blender-axi ...`, anticipating package publication. Because the npm package is not published today, use the source-installed global `blender-axi` binary when following those examples.

The file is generated from `src/skill.ts`, not edited by hand. `npm test` checks that the committed skill is current.

## Frozen Luna benchmark

A frozen, independently verified four-cell comparison used the same `codex-lb/gpt-5.6-luna` model at `xhigh` for both interfaces. P1 was a precise scene edit; P5 required running a broken script, diagnosing its first failure, repairing a copy, preserving dirty scene state, and saving the recovered artifact. Prompts and fixtures were frozen, paired fixtures were byte-identical, each cell received one attempt, and dispatch was strictly sequential.

| Result | Blender AXI | BlenderMCP | AXI difference |
| --- | ---: | ---: | ---: |
| Fully correct tasks | **2/2** | **0/2** | +2 correct tasks |
| Valid required artifacts | **2/2** | **0/2** | +2 valid artifacts |
| Total wall time | **394 s** | **702 s** | **43.9% less** |
| Combined input + output tokens | **104,113** | **116,219** | **10.4% fewer** |
| Output tokens | **19,610** | **35,295** | **44.4% fewer** |
| Reasoning tokens | **15,658** | **21,947** | **28.7% fewer** |
| Provider/load-balancer cost proxy | **0.040729** | **0.058815** | **30.8% lower** |

Reasoning tokens are included within output tokens, not additive. The provider/load-balancer figure is a relative self-reported proxy, not a measured or verified billing cost.

Per task:

- **P1:** AXI finished correctly in **93 s**. BlenderMCP finished in **102 s** but was incorrect and produced no required artifact.
- **P5:** AXI finished correctly in **301 s**. BlenderMCP reached the **600 s timeout**, remained incorrect, and produced an invalid required artifact.

**Bottom line:** under these frozen conditions Blender AXI produced more accurate results with less elapsed time, fewer generated tokens, and a lower provider-reported cost proxy than BlenderMCP.

> [!WARNING]
> **Limitations:** `n=1` per cell; only two prompts, one model and effort level, and one machine were tested. Cell 4 confounds interface arm with timeout. This is a controlled signal for these scenarios, not statistical proof of universal superiority or raw transport speed.

See the committed [four-cell result](benchmark/docs/LUNA-FOUR-CELL-RESULT.md) for cell-level evidence and arithmetic, and the [benchmark methodology](benchmark/docs/BENCHMARK.md) for fixture isolation, pinning, grading, safety, and reporting design.

The benchmark runtime is a separate package under `benchmark/`; it does not change the production CLI. Its live preflight is an explicit pin-gated command that can launch four paid model runs. **Never run `preflight execute` during normal development, tests, builds, or CI.**

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `No Blender addon answered for session "..." on port N` | Start GUI Blender, confirm the stock addon is enabled, and make its listener port match `blender-axi ping`. Connect or reconnect the listener, or intentionally use `start` / `--launch`. |
| A named session reports the wrong listener | `ping` shows the resolved port. Set the addon's port to match, then disconnect and reconnect; or pin `BLENDER_AXI_PORT`. |
| `Cannot render: scene has no mesh objects` | Build or open mesh geometry before rendering. |
| `Cannot export glTF: scene has no objects` | Add at least one scene object before using `--glb`. |
| Output begins or ends with `... (truncated, N chars total)` | This is the context guard. Re-run the same command with `--full`. |
| `blender-axi: command not found` | Run `npm link` after building, or use `node dist/bin/blender-axi.js`. |
| A script uses `bpy.ops.wm.read_homefile()` | Supported. Blender AXI re-resolves and normalizes context so later save, export, render, and summary actions target the replacement scene. |
| `stop` returns `not-owned` | The session has no readable PID file, so Blender AXI sent no signal. |
| `start` launches Blender but the requested named port never answers | Stock v1.2 can auto-start on `9876` before the launch-time port assignment. Start an isolated GUI Blender listener manually on the reported port; see the project notes in [`AGENTS.md`](AGENTS.md). |

## Development

```sh
npm test              # check generated skill, then run all tests
npm run build         # type-check and emit dist/
npm run build:skill   # regenerate skills/blender-axi/SKILL.md
npm run dev -- ping   # execute TypeScript source directly
```

`npm test` is self-isolating and does not require a reachable addon listener. Live acceptance does require GUI Blender with the stock addon listening; write all acceptance artifacts outside the repository, normally under `/tmp`.

For benchmark work, begin with [`benchmark/docs/BENCHMARK.md`](benchmark/docs/BENCHMARK.md). Its offline proof, live preflight, process ownership, pinning, grading, and reporting rules are authoritative. The live preflight is not a development or CI check.

## License

[MIT](LICENSE)
