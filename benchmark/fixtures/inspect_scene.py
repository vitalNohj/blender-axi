#!/usr/bin/env python3
"""Emit deterministic scene facts for benchmark grading."""

import argparse
import json
import math
import sys
from pathlib import Path

try:
    import bpy  # type: ignore[import-not-found]
    import bmesh  # type: ignore[import-not-found]
    from bpy_extras.object_utils import world_to_camera_view  # type: ignore[import-not-found]
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


def simple_value(value):
    if isinstance(value, (bool, int, str)) or value is None:
        return value
    if isinstance(value, float):
        return round(value, 6)
    try:
        return rounded(value)
    except (TypeError, ValueError):
        return None


def rna_facts(value, excluded=()):
    output = {}
    for prop in value.bl_rna.properties:
        if prop.identifier == "rna_type" or prop.identifier in excluded or prop.is_readonly:
            continue
        candidate = simple_value(getattr(value, prop.identifier))
        if candidate is not None:
            output[prop.identifier] = candidate
    return output


def world_facts(world):
    if not world:
        return None
    nodes = []
    if world.use_nodes and world.node_tree:
        for node in sorted(world.node_tree.nodes, key=lambda item: item.name):
            nodes.append({
                "name": node.name,
                "type": node.type,
                "inputs": {socket.name: simple_value(socket.default_value) for socket in node.inputs if hasattr(socket, "default_value")},
            })
    return {"settings": rna_facts(world), "nodes": nodes}


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
    collider_convex = None
    if evaluated.type == "MESH":
        mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            triangles = len(mesh.loop_triangles)
            vertices = len(mesh.vertices)
            if obj.name.startswith("COLLIDER_"):
                candidate = bmesh.new()
                try:
                    candidate.from_mesh(mesh)
                    result = bmesh.ops.convex_hull(candidate, input=list(candidate.verts), use_existing_faces=True)
                    collider_convex = not result.get("geom_interior")
                finally:
                    candidate.free()
        finally:
            evaluated.to_mesh_clear()
    return {
        "name": obj.name,
        "type": obj.type,
        "data_name": obj.data.name if obj.data else None,
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
        "collider_convex": collider_convex,
        "forward_y_world": rounded((obj.matrix_world.to_3x3() @ Vector((0, 1, 0))).normalized()),
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
    camera = scene.camera
    renders_inside_frame = None
    if camera and mesh_objects:
        framed = []
        for obj in scene.objects:
            if obj.type != "MESH":
                continue
            for corner in obj.bound_box:
                point = world_to_camera_view(scene, camera, obj.matrix_world @ Vector(corner))
                framed.append(point.z > 0 and 0 <= point.x <= 1 and 0 <= point.y <= 1)
        renders_inside_frame = all(framed)
    output = {
        "file": bpy.data.filepath,
        "scene": scene.name,
        "unit_system": scene.unit_settings.system,
        "unit_scale": scene.unit_settings.scale_length,
        "world": world_facts(scene.world),
        "render": {
            "settings": rna_facts(scene.render, excluded=("filepath",)),
            "image_settings": rna_facts(scene.render.image_settings),
            "view_settings": rna_facts(scene.view_settings),
            "camera": camera.name if camera else None,
        },
        "renders_inside_frame": renders_inside_frame,
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
