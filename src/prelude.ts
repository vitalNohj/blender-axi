export const RESULT_MARKER = "__BLENDER_AXI_RESULT__";

export interface PreludeOptions {
  filename?: string;
  save?: string;
  glb?: string;
  renderAngles?: string[];
  renderOutDir?: string;
  resolution?: { width: number; height: number };
}

function normalizedPrelude(): string {
  return `import bpy, json, traceback, io, os, math
from contextlib import redirect_stdout
D = bpy.data
C = bpy.context
_sc = C.scene
if _sc.world is None:
    _sc.world = D.worlds.new("World")
if len(_sc.objects) and C.view_layer.objects.active is None:
    _active = next((o for o in _sc.objects if not o.hide_viewport), _sc.objects[0])
    bpy.ops.object.select_all(action='DESELECT')
    _active.select_set(True)
    C.view_layer.objects.active = _active
_engine_items = _sc.render.bl_rna.properties['engine'].enum_items
BLENDER_AXI_RENDER_ENGINES = tuple(item.identifier for item in _engine_items)
`;
}

function glbCode(path: string): string {
  return `
_exportable = next((o for o in C.scene.objects if o.type == 'MESH'), next(iter(C.scene.objects), None))
if _exportable is None:
    raise RuntimeError("Cannot export glTF: scene has no objects")
bpy.ops.object.select_all(action='DESELECT')
_exportable.select_set(True)
C.view_layer.objects.active = _exportable
bpy.ops.export_scene.gltf(filepath=${JSON.stringify(path)}, export_format='GLB')
_blender_axi_artifacts.append(${JSON.stringify(path)})`;
}

function renderCode(angles: string[], outDir: string, resolution?: PreludeOptions["resolution"]): string {
  const angleMap: Record<string, number> = { front: 0, side: 90, back: 180, tq: 45 };
  const pairs = angles.map((name) => [name, angleMap[name]]);
  return `
_cam = C.scene.camera
if _cam is None:
    raise RuntimeError("Cannot render: scene has no active camera")
${resolution ? `_sc.render.resolution_x = ${resolution.width}\n_sc.render.resolution_y = ${resolution.height}` : ""}
_target_z = 0.5 * (min((o.matrix_world.translation.z for o in C.scene.objects if o.type == 'MESH'), default=0.0) + max((o.matrix_world.translation.z for o in C.scene.objects if o.type == 'MESH'), default=2.0))
_target = mathutils.Vector((0.0, 0.0, _target_z)) if 'mathutils' in globals() else __import__('mathutils').Vector((0.0, 0.0, _target_z))
_radius = max(0.001, math.sqrt(_cam.location.x ** 2 + _cam.location.y ** 2))
for _angle_name, _degrees in ${JSON.stringify(pairs)}:
    _theta = math.radians(_degrees)
    _cam.location.x = _radius * math.sin(_theta)
    _cam.location.y = -_radius * math.cos(_theta)
    _cam.rotation_euler = (_target - _cam.location).to_track_quat('-Z', 'Y').to_euler()
    _render_path = os.path.join(${JSON.stringify(outDir)}, "render-" + _angle_name + ".png")
    os.makedirs(os.path.dirname(_render_path) or '.', exist_ok=True)
    _sc.render.filepath = _render_path
    _sc.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
    _blender_axi_artifacts.append(_render_path)`;
}

export function generatePrelude(source: string, options: PreludeOptions = {}): string {
  const filename = options.filename ?? "<blender-axi>";
  const actions = [
    options.save
      ? `\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(options.save)})\n_blender_axi_artifacts.append(${JSON.stringify(options.save)})`
      : "",
    options.glb ? glbCode(options.glb) : "",
    options.renderAngles?.length
      ? renderCode(options.renderAngles, options.renderOutDir ?? process.cwd(), options.resolution)
      : "",
  ].join("");
  const quietActions = actions
    ? `\n        with redirect_stdout(io.StringIO()):${actions
        .split("\n")
        .map((line) => `\n            ${line}`)
        .join("")}`
    : "";

  return `${normalizedPrelude()}_blender_axi_stdout = io.StringIO()
_blender_axi_artifacts = []
try:
    with redirect_stdout(_blender_axi_stdout):
        exec(compile(${JSON.stringify(source)}, ${JSON.stringify(filename)}, 'exec'), globals(), globals())${quietActions}
    print(${JSON.stringify(RESULT_MARKER)} + json.dumps({"ok": True, "stdout": _blender_axi_stdout.getvalue(), "artifacts": _blender_axi_artifacts}))
except Exception as _blender_axi_exc:
    print(${JSON.stringify(RESULT_MARKER)} + json.dumps({"ok": False, "error": str(_blender_axi_exc), "traceback": traceback.format_exc(), "stdout_before_failure": _blender_axi_stdout.getvalue()}))
`;
}

interface ExecutionSuccess {
  ok: true;
  stdout: string;
  artifacts: string[];
}

interface ExecutionFailure {
  ok: false;
  error: string;
  traceback: string;
  stdout_before_failure: string;
}

export type ExecutionResult = ExecutionSuccess | ExecutionFailure;

export function parseExecutionOutput(output: string): ExecutionResult {
  const index = output.lastIndexOf(RESULT_MARKER);
  if (index < 0) throw new Error("Blender addon response did not contain an AXI result marker");
  const line = output.slice(index + RESULT_MARKER.length).split(/\r?\n/, 1)[0];
  try {
    return JSON.parse(line) as ExecutionResult;
  } catch (error) {
    throw new Error(
      `Blender AXI result was invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
