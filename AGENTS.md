# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- The wire protocol and Blender behavior are implemented in `src/protocol.ts` and `src/prelude.ts`; keep compatibility with the unmodified BlenderMCP v1.2 addon.
- Run `npm test` and `npm run build`. Live acceptance requires a GUI Blender addon listener and must write artifacts outside reference workspaces, typically under `/tmp`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
