#!/usr/bin/env python3
"""Generate deterministic Blender benchmark fixtures from neutral JSON contracts."""

import argparse
import json
import math
import shutil
import sys
from pathlib import Path

try:
    import bpy  # type: ignore[import-not-found]
except ImportError as error:
    raise SystemExit("Run this script through the pinned Blender executable") from error


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    if scene.world is None:
        scene.world = bpy.data.worlds.new("BenchmarkWorld")
    scene.world.color = (0.035, 0.035, 0.035)
    return scene


def ensure_collection(name):
    if name in bpy.data.collections:
        return bpy.data.collections[name]
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    return collection


def move_to_collection(obj, name):
    collection = ensure_collection(name)
    for current in list(obj.users_collection):
        current.objects.unlink(obj)
    collection.objects.link(obj)


def add_object(spec):
    kind = spec["type"]
    if kind == "cube":
        bpy.ops.mesh.primitive_cube_add(size=1)
        obj = bpy.context.object
    elif kind == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.5, depth=1)
        obj = bpy.context.object
    elif kind == "uv_sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.5)
        obj = bpy.context.object
    elif kind == "camera":
        data = bpy.data.cameras.new(spec["name"])
        obj = bpy.data.objects.new(spec["name"], data)
        bpy.context.scene.collection.objects.link(obj)
        bpy.context.scene.camera = obj
    elif kind == "area_light":
        data = bpy.data.lights.new(spec["name"], "AREA")
        data.energy = spec.get("energy", 800)
        data.shape = "DISK"
        data.size = 4
        obj = bpy.data.objects.new(spec["name"], data)
        bpy.context.scene.collection.objects.link(obj)
    else:
        raise ValueError(f"Unsupported object type: {kind}")

    obj.name = spec["name"]
    if "location" in spec:
        obj.location = spec["location"]
    if "dimensions" in spec:
        obj.dimensions = spec["dimensions"]
        if obj.type == "MESH":
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            obj.select_set(False)
    if "rotation_degrees" in spec:
        obj.rotation_euler = [math.radians(value) for value in spec["rotation_degrees"]]
    if "custom_properties" in spec:
        for key, value in spec["custom_properties"].items():
            obj[key] = value
    if "material" in spec and obj.type == "MESH":
        material = bpy.data.materials.get(spec["material"]) or bpy.data.materials.new(spec["material"])
        obj.data.materials.append(material)
    if "collection" in spec:
        move_to_collection(obj, spec["collection"])
    return obj


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--fixture-root", required=True)
    script_args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parser.parse_args(script_args)

    spec_path = Path(args.spec).resolve()
    output = Path(args.output).resolve()
    fixture_root = Path(args.fixture_root).resolve()
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Cannot load fixture spec {spec_path}: {error}") from error
    scene = clear_scene()
    for name in spec["scene"].get("collections", []):
        ensure_collection(name)
    for object_spec in spec["scene"].get("objects", []):
        add_object(object_spec)

    if spec["task_id"] == "P5":
        source = fixture_root / "scripts" / "faulty_build.py"
        shutil.copyfile(source, output.parent / "faulty_build.py")
        scene["benchmark_dirty_fixture"] = True
        scene["benchmark_unsaved_contract"] = "PreserveMarker must survive recovery"

    scene["benchmark_task_id"] = spec["task_id"]
    scene["benchmark_fixture_schema"] = spec["schema_version"]
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(output), check_existing=False)
    print(json.dumps({"ok": True, "task_id": spec["task_id"], "path": str(output)}))


if __name__ == "__main__":
    main()
