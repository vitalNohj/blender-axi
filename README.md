# blender-axi

Token-efficient agent CLI for driving Blender through its stock [BlenderMCP](https://github.com/ahujasid/blender-mcp) v1.2 addon.

`blender-axi` speaks the addon's raw TCP protocol directly. There is no MCP server to register, no `uvx` process to keep alive, and no patched addon — just a command you run when you actually need Blender.

## Why a CLI instead of an MCP server

An MCP server is resident. Its tool schemas are injected into the agent's context window at the start of every session, whether or not the agent ever touches Blender. A CLI costs **zero tokens until invoked**, and the agent already knows how to run commands.

Beyond the resident cost, `blender-axi` is shaped so each invocation returns less:

- **TOON output, not JSON.** Structured results render as compact key/value and tabular text instead of brace-and-quote-heavy JSON. `--json` is there when a machine-readable envelope is genuinely wanted.
- **Aggregates before detail.** `scene` returns counts first, so the common "how big is this scene" question costs a handful of lines instead of a full object dump. Object rows are opt-in via `--fields` / `--full`.
- **One round-trip for a whole build.** `build` runs your script, saves, exports glTF, and renders camera angles in a single socket request, and returns the resulting scene aggregate — instead of five tool calls and five responses.
- **Failures arrive actionable.** `exec` wraps your script so a crash returns the exception, its Python traceback, and the stdout printed *before* the failure. No follow-up call to ask "what actually broke".
- **Long output is truncated with an escape hatch.** Execution stdout and traceback fields over 1500 characters are cut with their total size and a `--full` hint, so one chatty script can't flood the context.

## Prerequisites

- **Node 20+**
- **Blender 3.2+** running as a GUI application
- **The stock BlenderMCP addon (v1.2)** — used unmodified

## Install

```sh
git clone https://github.com/vitalNohj/blender-axi.git
cd blender-axi
npm install
npm run build
npm link
```

`npm link` puts `blender-axi` on your `PATH`. Without it, invoke the built entry point directly as `node dist/bin/blender-axi.js`.

## Blender addon setup

1. Download `addon.py` from [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp).
2. In Blender: **Edit > Preferences > Add-ons > Install...**, select `addon.py`, and enable **Interface: Blender MCP**.
3. Press <kbd>N</kbd> in the 3D viewport and open the **BlenderMCP** sidebar tab.
4. Leave **Port** at `9876` (or set it to match your session — see [Sessions](#sessions-and-safety)) and click **Connect to Claude**. That button just starts the addon's TCP listener; `blender-axi` talks to it directly.

## First commands

Run `blender-axi` with no arguments for a content-first status view — it reports the resolved session and port rather than dumping help text:

```
$ blender-axi
bin: ~/blender-axi/dist/bin/blender-axi.js
description: "Drive Blender through its stock BlenderMCP TCP addon with isolated sessions, atomic builds, tracebacks, and camera renders."
ok: true
session: default
port: 9876
```

```sh
blender-axi ping          # confirm the addon is listening
blender-axi scene         # aggregate scene counts
blender-axi --help        # commands, flags, and examples
blender-axi scene --help  # per-command help, no connection needed
```

## Workflows

### Inspect a scene

`scene` is counts-first, and tells you how to get more:

```
$ blender-axi scene
objects: 5
meshes: 3
triangles: 1248
materials: 2
collections: 1
name: Scene
help[1]: Run `blender-axi scene --full` to show all 5 objects
```

Opt into object rows with only the columns you need (`name`, `type`, `visible`, `selected`, `vertices`):

```
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

`--full` returns every object with `name,type`.

### Run Python

```sh
blender-axi exec script.py
cat script.py | blender-axi exec -
```

Your script runs with `bpy`, `D` (`bpy.data`), `C` (`bpy.context`), and `_sc` (the active scene) already resolved. A failure returns everything needed to fix it in one response:

```
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
blender-axi build model.py --save /tmp/ship.blend --render front,side --glb /tmp/ship.glb
```

One socket round-trip runs save → glTF export → render sequentially, returning artifacts and the resulting scene aggregate. These actions are not rolled back, so files written by an earlier action can remain if a later action fails:

```
ok: true
stdout: |
  built hull
artifacts[4]:
  - "/tmp/ship.blend"
  - "/tmp/ship.glb"
  - "/tmp/render-front.png"
  - "/tmp/render-side.png"
scene:
  objects: 4
  meshes: 2
  triangles: 96
  materials: 1
  collections: 1
```

The supported build action flags are `--save`, `--render`, and `--glb`. Each is independent — use `--save` alone to just persist, or `--glb` alone to just export. Build renders are written beside `--save`, or to the current directory when no `--save` path is given.

### Render for visual verification

```sh
blender-axi render front,side,back,tq --out /tmp/renders --res 880x1180
```

Angles are a comma-separated subset of `front`, `side`, `back`, `tq` (three-quarter). `render` orbits the existing camera around the scene's vertical midpoint, and creates a camera and a sun lamp if the scene has none. `--out` defaults to the current directory; `--res` defaults to the scene's own resolution.

## Output format and artifacts

Output is [TOON](https://github.com/toon-format/toon) — compact, structured, human- and agent-readable. Add `--json` for a JSON envelope.

On success, CLI-managed `--save`, `--glb`, and `--render` actions that completed are reported in the `artifacts` list. Renders are named `render-<angle>.png`. Build renders are written beside `--save`, or to the current directory when no `--save` path is given; standalone `render` defaults to the current directory. On failure, the response contains `error`, `traceback`, and `stdout_before_failure` without an `artifacts` list, so files written before the failure are not reported. Arbitrary Python run by `exec` or `build` may also write files that the CLI does not track. Paths you pass are used as given, so prefer absolute paths outside your source tree — `/tmp` is a good default — to keep generated `.blend`, `.glb`, and `.png` files out of the repository.

Exit codes: `0` success or idempotent no-op, `1` execution or connection failure, `2` invalid usage.

## Sessions and safety

`blender-axi` never guesses which Blender to talk to, and never silently falls back to another one.

The default session uses port `9876`. Named sessions hash deterministically into ports `9877`–`10876` with their own state directory under `~/.blender-axi/sessions/`, so parallel agents can each drive their own Blender:

```sh
BLENDER_AXI_SESSION=worker-1 blender-axi start
BLENDER_AXI_SESSION=worker-1 blender-axi build model.py --save /tmp/worker-1.blend
```

The Blender instance must have its addon **Port** set to the session's port. `blender-axi ping` reports the port a session resolved to.

| Variable | Purpose |
| --- | --- |
| `BLENDER_AXI_SESSION` | Session name (1–64 chars, `A-Za-z0-9._-`) |
| `BLENDER_AXI_PORT` | Explicit port override, e.g. to resolve a rare hash collision |
| `BLENDER_AXI_BLENDER` | Blender executable for `start` / `--launch`. Defaults to the macOS app path (`/Applications/Blender.app/Contents/MacOS/Blender`); set it explicitly on Linux and Windows |

Process lifecycle is always explicit:

- Ordinary commands **never** launch Blender. They fail clearly when the port is dead.
- `--launch` opts a command into starting Blender only if it isn't already up.
- `start` launches a Blender GUI owned by this session and waits for its addon port.
- `stop` targets the PID recorded by this session and reports `not-owned` when no PID file exists. It trusts that recorded PID without verifying the process identity, so a stale PID reused by the operating system could be signalled.

Note that `exec` and `build` run arbitrary Python inside Blender via the addon's `execute_code`. Only run scripts you trust.

## Agent integration

Both paths below are optional and complementary — neither is required to use the CLI.

**Session hooks** give agents ambient connection state at session start:

```sh
blender-axi setup hooks   # Claude Code, Codex, OpenCode
```

**The packaged skill** at [`skills/blender-axi/`](skills/blender-axi/SKILL.md) provides on-demand guidance that costs nothing until an agent loads it:

```sh
npx skills add vitalNohj/blender-axi --skill blender-axi
```

The skill's commands are written as `npx -y blender-axi ...`, which requires the npm package. Until `blender-axi` is published to npm, install from source as above and use the global `blender-axi` binary.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `No Blender addon answered for session "..." on port N` | Blender isn't running, the addon listener isn't started, or the addon's **Port** doesn't match. Click **Connect to Claude** in the BlenderMCP sidebar, or add `--launch`. |
| Wrong port for a named session | Run `blender-axi ping` to see the resolved port, then set the addon's **Port** to match, or pin it with `BLENDER_AXI_PORT`. |
| `Cannot render: scene has no mesh objects` | `render` needs at least one mesh. Build geometry first. |
| `Cannot export glTF: scene has no objects` | `--glb` needs something to export. |
| Output ends in `... (truncated, N chars total)` | Intentional context guard. Re-run with `--full`. |
| `blender-axi: command not found` | `npm link` wasn't run, or use `node dist/bin/blender-axi.js` directly. |
| A script called `bpy.ops.wm.read_homefile()` and later steps behaved oddly | Handled: `blender-axi` re-resolves and normalizes Blender's context after a scene reset so save, export, and render act on the replacement scene. |
| `stop` reports `not-owned` | This session has no readable PID file, so no signal is sent. Otherwise `stop` signals the recorded PID without verifying process identity. |

## Development

```sh
npm test           # regenerate-check the skill, then run the suite
npm run build      # tsc type-check and emit to dist/
npm run build:skill  # regenerate skills/blender-axi/SKILL.md from src/skill.ts
npm run dev -- ping  # run from TypeScript source without building
```

`skills/blender-axi/SKILL.md` is generated. Edit `src/skill.ts` and re-run `npm run build:skill`; `npm test` fails if the committed file is stale.

Run `npm test` with `BLENDER_AXI_PORT` and `BLENDER_AXI_SESSION` unset and a reachable addon listener on the default port. The render usage-error test connects before validating angles.

Live acceptance against a real Blender requires a GUI instance with the addon listener running, and should write artifacts outside the source tree.

## License

[MIT](LICENSE)
