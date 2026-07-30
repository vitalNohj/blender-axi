# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- The wire protocol and Blender behavior are implemented in `src/protocol.ts` and `src/prelude.ts`; keep compatibility with the unmodified BlenderMCP v1.2 addon. User scripts may replace the active file with `bpy.ops.wm.read_homefile`, so post-build actions must re-resolve and normalize Blender context.
- Run `npm test` and `npm run build`. Live acceptance requires a GUI Blender addon listener and must write artifacts outside reference workspaces, typically under `/tmp`.
- The suite is self-isolating: `src/cli.test.ts` pins `BLENDER_AXI_PORT` to a dead port, so it passes with or without a Blender listener. Commands must validate arguments before `connected(...)` to keep that true; see `buildCommand`/`renderCommand` in `src/cli.ts`.
- Live acceptance needs a GUI Blender: the addon refuses to listen under `blender -b`, and a detached GUI spawn does not reliably come up in a headless agent environment. Start one in the foreground and confirm the port with `blender-axi ping`.
- The addon auto-starts a listener on the scene's port at register time, so `blender-axi start`'s `--python-expr` port assignment arrives too late and a second instance dies with `Address already in use` on 9876. For an isolated session, stop `bpy.types.blendermcp_server` and construct a fresh `BlenderMCPServer(port=...)` from a `--python` startup script.
- `--glb` must export evaluated geometry without mutating the source scene; see `glbCode` in `src/prelude.ts` and the parity tests in `src/cli.glb.test.ts`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
