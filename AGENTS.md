# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- The wire protocol and Blender behavior are implemented in `src/protocol.ts` and `src/prelude.ts`; keep compatibility with the unmodified BlenderMCP v1.2 addon. User scripts may replace the active file with `bpy.ops.wm.read_homefile`, so post-build actions must re-resolve and normalize Blender context.
- Run `npm test` and `npm run build`. Live acceptance requires a GUI Blender addon listener and must write artifacts outside reference workspaces, typically under `/tmp`.
- Run tests with `BLENDER_AXI_PORT`/`BLENDER_AXI_SESSION` unset. `render` validates angles only after connecting (`src/cli.ts`), so the usage-error test in `src/cli.test.ts` needs a reachable default port and fails when pointed at a dead one. This makes the suite environment-dependent, so it will fail on a machine with no Blender listener.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
