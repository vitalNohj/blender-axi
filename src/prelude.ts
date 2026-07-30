export const RESULT_MARKER = "__BLENDER_AXI_RESULT__";

export interface PreludeOptions {
	filename?: string;
	save?: string;
	glb?: string;
	renderAngles?: string[];
	renderOutDir?: string;
	resolution?: { width: number; height: number };
	summarize?: boolean;
}

function normalizedPrelude(): string {
	return `import bpy, json, traceback, io, os, math, sys, ast
from contextlib import redirect_stdout
_blender_axi_context_overrides = []
def _blender_axi_normalize_scene():
    global D, C, _sc, BLENDER_AXI_RENDER_ENGINES
    D = bpy.data
    C = bpy.context
    if C.window is None:
        _window = next(iter(C.window_manager.windows), None)
        if _window is not None:
            _override = C.temp_override(window=_window)
            _override.__enter__()
            _blender_axi_context_overrides.append(_override)
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
def _blender_axi_read_homefile_and_normalize(*args, **kwargs):
    _result = bpy.ops.wm.read_homefile(*args, **kwargs)
    _blender_axi_normalize_scene()
    return _result
class _BlenderAxiResetTransformer(ast.NodeTransformer):
    def visit_Call(self, node):
        self.generic_visit(node)
        if isinstance(node.func, ast.Attribute) and node.func.attr == 'read_homefile' and isinstance(node.func.value, ast.Attribute) and node.func.value.attr == 'wm' and isinstance(node.func.value.value, ast.Attribute) and node.func.value.value.attr == 'ops' and isinstance(node.func.value.value.value, ast.Name) and node.func.value.value.value.id == 'bpy':
            node.func = ast.copy_location(ast.Name(id='_blender_axi_read_homefile_and_normalize', ctx=ast.Load()), node.func)
        return node
def _blender_axi_compile(source, filename):
    _tree = _BlenderAxiResetTransformer().visit(ast.parse(source, filename=filename, mode='exec'))
    ast.fix_missing_locations(_tree)
    return compile(_tree, filename, 'exec')
def _blender_axi_scene_summary():
    _depsgraph = C.evaluated_depsgraph_get()
    _meshes = [o for o in _sc.objects if o.type == 'MESH']
    _triangles = 0
    for _object in _meshes:
        _evaluated = _object.evaluated_get(_depsgraph)
        _mesh = _evaluated.to_mesh()
        try:
            _triangles += sum(len(p.vertices) - 2 for p in _mesh.polygons)
        finally:
            _evaluated.to_mesh_clear()
    return {"objects": len(_sc.objects), "meshes": len(_meshes), "triangles": _triangles, "materials": len(D.materials), "collections": len(D.collections)}
_blender_axi_normalize_scene()
`;
}

/**
 * `export_apply=True` makes the exporter read each object's evaluated mesh, so
 * the GLB matches the depsgraph result the scene summary and renders report.
 * The exporter evaluates into temporary data and never writes back, so source
 * modifiers stay in the stack and editable.
 */
function glbCode(path: string): string {
	return `
_exportable = next((o for o in C.scene.objects if o.type == 'MESH'), next(iter(C.scene.objects), None))
if _exportable is None:
    raise RuntimeError("Cannot export glTF: scene has no objects")
bpy.ops.object.select_all(action='DESELECT')
_exportable.select_set(True)
C.view_layer.objects.active = _exportable
bpy.ops.export_scene.gltf(filepath=${JSON.stringify(path)}, export_format='GLB', export_apply=True)
_blender_axi_artifacts.append(${JSON.stringify(path)})`;
}

function renderCode(
	angles: string[],
	outDir: string,
	resolution?: PreludeOptions["resolution"],
): string {
	const angleMap: Record<string, number> = {
		front: 0,
		side: 90,
		back: 180,
		tq: 45,
	};
	const pairs = angles.map((name) => [name, angleMap[name]]);
	return `
_cam = C.scene.camera
_mesh_objects = [o for o in C.scene.objects if o.type == 'MESH']
if not _mesh_objects:
    raise RuntimeError("Cannot render: scene has no mesh objects")
_target_z = 0.5 * (min(o.matrix_world.translation.z for o in _mesh_objects) + max(o.matrix_world.translation.z for o in _mesh_objects))
if _cam is None:
    _camera_data = D.cameras.new("Camera")
    _cam = D.objects.new("Camera", _camera_data)
    _sc.collection.objects.link(_cam)
    _radius = max(2.5, max(max(o.dimensions) for o in _mesh_objects) * 2.5)
    _cam.location = (0.0, -_radius, _target_z)
    _sc.camera = _cam
if not any(o.type == 'LIGHT' for o in C.scene.objects):
    _light_data = D.lights.new("Sun", 'SUN')
    _light_data.energy = 3.0
    _light = D.objects.new("Sun", _light_data)
    _light.rotation_euler = (math.radians(35), math.radians(-25), math.radians(-25))
    _sc.collection.objects.link(_light)
${resolution ? `_sc.render.resolution_x = ${resolution.width}\n_sc.render.resolution_y = ${resolution.height}` : ""}
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

export function generatePrelude(
	source: string,
	options: PreludeOptions = {},
): string {
	const filename = options.filename ?? "<blender-axi>";
	const actions = [
		options.save
			? `\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(options.save)})\n_blender_axi_artifacts.append(${JSON.stringify(options.save)})`
			: "",
		options.glb ? glbCode(options.glb) : "",
		options.renderAngles?.length
			? renderCode(
					options.renderAngles,
					options.renderOutDir ?? process.cwd(),
					options.resolution,
				)
			: "",
	].join("");
	const quietActions = actions
		? `\n        _blender_axi_normalize_scene()\n        with redirect_stdout(io.StringIO()):${actions
				.split("\n")
				.map((line) => `\n            ${line}`)
				.join("")}`
		: "";
	const summary = options.summarize
		? `\n        _blender_axi_normalize_scene()\n        with redirect_stdout(io.StringIO()):\n            _blender_axi_summary = _blender_axi_scene_summary()`
		: "";
	const summaryField = options.summarize
		? `, "scene": _blender_axi_summary`
		: "";

	return `${normalizedPrelude()}_blender_axi_stdout = io.StringIO()
_blender_axi_artifacts = []
try:
    with redirect_stdout(_blender_axi_stdout):
        exec(_blender_axi_compile(${JSON.stringify(source)}, ${JSON.stringify(filename)}), globals(), globals())${quietActions}${summary}
    print(${JSON.stringify(RESULT_MARKER)} + json.dumps({"ok": True, "stdout": _blender_axi_stdout.getvalue(), "artifacts": _blender_axi_artifacts${summaryField}}))
except Exception as _blender_axi_exc:
    print(${JSON.stringify(RESULT_MARKER)} + json.dumps({"ok": False, "error": str(_blender_axi_exc), "traceback": traceback.format_exc(), "stdout_before_failure": _blender_axi_stdout.getvalue()}))
finally:
    for _override in reversed(_blender_axi_context_overrides):
        _override.__exit__(*sys.exc_info())
`;
}

export interface SceneSummary {
	objects: number;
	meshes: number;
	triangles: number;
	materials: number;
	collections: number;
}

interface ExecutionSuccess {
	ok: true;
	stdout: string;
	artifacts: string[];
	scene?: SceneSummary;
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
	if (index < 0)
		throw new Error(
			"Blender addon response did not contain an AXI result marker",
		);
	const line = output.slice(index + RESULT_MARKER.length).split(/\r?\n/, 1)[0];
	try {
		return JSON.parse(line) as ExecutionResult;
	} catch (error) {
		throw new Error(
			`Blender AXI result was invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
