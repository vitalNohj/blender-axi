---
name: blender-axi
description: "Drive Blender modeling, rendering, and Python scripting through the blender-axi CLI. Use when creating or inspecting 3D scenes, executing bpy scripts with actionable tracebacks, building and exporting models in one request, or producing camera renders from a running stock BlenderMCP addon."
user-invocable: false
author: Nohj
metadata:
  hermes:
    tags: [blender, 3d-modeling, rendering, python, bpy, cli]
    category: creative
---

# blender-axi

Drive Blender through its stock BlenderMCP TCP addon with isolated sessions, one-request builds, tracebacks, and camera renders.

You do not need blender-axi installed globally - invoke it with `npx -y blender-axi <command>`.
If blender-axi output shows a follow-up command starting with `blender-axi`, run it as
`npx -y blender-axi ...` instead.

## When to use

Use blender-axi to inspect a live Blender scene, execute bpy Python with complete failure
tracebacks, build/save/export/render a model in one request, or produce camera renders for visual
verification. It speaks directly to the stock BlenderMCP v1.2 addon's TCP listener and does not
require an MCP server or patched addon.

## Workflow

1. Run `npx -y blender-axi ping` to confirm the selected Blender addon listener is available.
2. Run `npx -y blender-axi scene` for aggregate scene counts. Add `--fields name,type` only
   when object detail is needed; use `--full` for every object's name and type.
3. Run `npx -y blender-axi exec <file|->` for Python. Failures return the exception, full
   traceback, and stdout produced before failure. Use `--full` if long output is truncated.
4. Run `npx -y blender-axi build <file> --save <path> --render front,side --glb <path>` when
   build, save, export, and renders must remain a single one-request Blender round-trip.
5. Run `npx -y blender-axi render <angles> --out <dir>` to write camera PNGs for inspection.
6. Set `BLENDER_AXI_SESSION` for isolated session-to-port mapping or `BLENDER_AXI_PORT` for
   an explicit listener. Commands fail loudly instead of falling back to another session.
7. Run `npx -y blender-axi setup hooks` only when the user wants ambient SessionStart context.

## Usage

```
usage: npx -y blender-axi [command] [args] [flags]
commands[10]: (none)=connection status,ping,exec,run=alias of exec,build,render,scene,start,stop,setup
flags[5]: "--launch (start Blender only when needed)","--json","--full","--help","-v/-V/--version"
"session env"[2]: BLENDER_AXI_SESSION,BLENDER_AXI_PORT
examples[6]: npx -y blender-axi ping,npx -y blender-axi exec script.py,"npx -y blender-axi build build.py --save /tmp/model.blend --render front,side --glb /tmp/model.glb","npx -y blender-axi render front,side --out /tmp/renders --res 880x1180",npx -y blender-axi start,npx -y blender-axi setup hooks
```

## Tips

- Output is TOON-encoded and token-efficient by default. `--json` is available where a JSON
  envelope is useful.
- Exit code 0 means success or an idempotent no-op, 1 means an execution/runtime failure, and 2
  means invalid usage.
- `start` and `--launch` may launch Blender; `stop` only stops the process recorded as owned
  by the same session. Ordinary commands never opt into lifecycle changes implicitly.
- See the README's build/export section for `--glb` modifier and shape-key semantics.
- Keep artifacts outside reference workspaces when validating builds, typically under `/tmp`.
