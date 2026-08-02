#!/usr/bin/env python3
"""Emit deterministic scene facts for benchmark grading."""

import argparse
import json
import math
import sys
from pathlib import Path

try:
    import bpy  # type: ignore[import-not-found]
    from mathutils import Vector  # type: ignore[import-not-found]
except ImportError as error:
    raise SystemExit("Run this script through Blender") from error


def rounded(values, digits=6):
    try:
        return [round(float(value), digits) for value in values]
    except (TypeError, ValueError) as error:
        raise ValueError(f"Scene value is not numeric: {values}") from error


def srgb_channel(value):
    if value <= 0.0031308:
        return 12.92 * value
    return 1.055 * math.pow(value, 1 / 2.4) - 0.055


def material_facts(material):
    color = material.diffuse_color[:3]
    output = {
        "name": material.name,
        "base_color_linear": rounded(color),
        "base_color_srgb": rounded([srgb_channel(value) for value in color]),
        "use_nodes": material.use_nodes,
        "emission_color_srgb": None,
        "emission_strength": None,
    }
    if material.use_nodes and material.node_tree:
        for node in material.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                base = node.inputs.get("Base Color")
                if base:
                    output["base_color_linear"] = rounded(base.default_value[:3])
                    output["base_color_srgb"] = rounded([srgb_channel(value) for value in base.default_value[:3]])
                emission = node.inputs.get("Emission Color") or node.inputs.get("Emission")
                strength = node.inputs.get("Emission Strength")
                if emission:
                    output["emission_color_srgb"] = rounded([srgb_channel(value) for value in emission.default_value[:3]])
                if strength:
                    try:
                        output["emission_strength"] = round(float(strength.default_value), 6)
                    except (TypeError, ValueError) as error:
                        raise ValueError(f"Invalid emission strength in {material.name}") from error
    return output


def object_facts(obj, depsgraph):
    world_corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box] if obj.type == "MESH" else []
    evaluated = obj.evaluated_get(depsgraph)
    triangles = 0
    vertices = 0
    if evaluated.type == "MESH":
        mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            triangles = len(mesh.loop_triangles)
            vertices = len(mesh.vertices)
        finally:
            evaluated.to_mesh_clear()
    return {
        "name": obj.name,
        "type": obj.type,
        "parent": obj.parent.name if obj.parent else None,
        "location": rounded(obj.location),
        "rotation_euler": rounded(obj.rotation_euler),
        "scale": rounded(obj.scale),
        "dimensions": rounded(obj.dimensions),
        "matrix_world": [rounded(row) for row in obj.matrix_world],
        "bounds_min": rounded([min(corner[index] for corner in world_corners) for index in range(3)]) if world_corners else None,
        "bounds_max": rounded([max(corner[index] for corner in world_corners) for index in range(3)]) if world_corners else None,
        "triangles": triangles,
        "vertices": vertices,
        "materials": [slot.material.name if slot.material else None for slot in obj.material_slots],
        "custom_properties": {key: obj[key] for key in sorted(obj.keys()) if key != "_RNA_UI"},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--allowed-root", required=True)
    script_args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parser.parse_args(script_args)
    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()
    objects = [object_facts(obj, depsgraph) for obj in sorted(scene.objects, key=lambda item: item.name)]
    mesh_objects = [item for item in objects if item["type"] == "MESH"]
    all_mins = [item["bounds_min"] for item in mesh_objects if item["bounds_min"]]
    all_maxs = [item["bounds_max"] for item in mesh_objects if item["bounds_max"]]
    output = {
        "file": bpy.data.filepath,
        "scene": scene.name,
        "unit_system": scene.unit_settings.system,
        "unit_scale": scene.unit_settings.scale_length,
        "objects": objects,
        "materials": [material_facts(material) for material in sorted(bpy.data.materials, key=lambda item: item.name)],
        "totals": {
            "objects": len(objects),
            "meshes": len(mesh_objects),
            "triangles": sum(item["triangles"] for item in mesh_objects),
            "materials": len(bpy.data.materials),
        },
        "mesh_bounds_min": rounded([min(value[index] for value in all_mins) for index in range(3)]) if all_mins else None,
        "mesh_bounds_max": rounded([max(value[index] for value in all_maxs) for index in range(3)]) if all_maxs else None,
    }
    path = Path(args.output).resolve()
    allowed_root = Path(args.allowed_root).resolve()
    if not path.is_relative_to(allowed_root):
        raise SystemExit(f"Output must stay under {allowed_root}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "output": str(path), "objects": len(objects)}))


if __name__ == "__main__":
    main()
