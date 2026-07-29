# blender-axi

`blender-axi` drives Blender through the stock BlenderMCP v1.2 addon's raw TCP socket. It replaces the resident MCP server with an on-demand AXI CLI, so it costs no context tokens until invoked and needs no MCP registration, `uvx`, or patched addon.

## Install and build

```sh
npm install
npm run build
npm link
```

Node 20 or newer is required. In Blender, enable the stock BlenderMCP addon and start its socket server.

For on-demand agent discovery without a global binary, install the packaged skill instead:

```sh
npx skills add nohj/blender-axi --skill blender-axi
```

Session hooks and the skill are complementary installation paths, but only one is required. Run
`blender-axi setup hooks` for ambient live connection state, or install the skill for zero-cost
on-demand guidance. Skill commands use `npx -y blender-axi` so they do not assume a global binary.

## Commands

```sh
blender-axi ping
blender-axi exec script.py
cat script.py | blender-axi exec -
blender-axi build script.py --save /tmp/model.blend --render front,side --glb /tmp/model.glb
blender-axi render front,side,back,tq --out /tmp/renders --res 880x1180
blender-axi scene --fields visible,vertices --full
blender-axi start
blender-axi stop
blender-axi setup hooks
```

`exec` wraps Python before sending it, so failures against the unmodified addon include the full traceback and stdout printed before failure. Long execution output is truncated with its total size and a `--full` escape hatch. `build` performs build, save, glTF export, and camera rendering in one socket round-trip, with save before export and render.

`scene` returns total counts and compact `name,type` object rows. It lists 20 items per group by default and prints a contextual `--full` hint when more exist. `--fields visible,selected,vertices` adds only the requested object columns.

All commands fail clearly when the selected port is dead. Add `--launch` to `ping`, `exec`, `build`, `render`, or `scene` to opt into launching Blender. `start` explicitly launches Blender. `stop` only stops a process launched and recorded by the same session, never an unrelated GUI instance.

## Session isolation

The default session uses port 9876. Named sessions deterministically map into ports 9877-10876 and separate state directories under `~/.blender-axi/sessions/`:

```sh
BLENDER_AXI_SESSION=worker-1 blender-axi start
BLENDER_AXI_SESSION=worker-1 blender-axi build script.py --save /tmp/worker-1.blend
```

Set `BLENDER_AXI_PORT` to select an explicit port or resolve a rare hash collision. A Blender instance must have its addon's scene port configured to the same value. `BLENDER_AXI_BLENDER` can override the Blender executable used by `start` and `--launch`.

## Development

```sh
npm run build:skill
npm test
npm run build
```
