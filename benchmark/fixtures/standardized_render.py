#!/usr/bin/env python3
"""Render fixed post-hoc benchmark views without using agent cameras or lights."""

import argparse
import math
import sys
from pathlib import Path

try:
    import bpy  # type: ignore[import-not-found]
    from mathutils import Vector  # type: ignore[import-not-found]
except ImportError as error:
    raise SystemExit("Run this script through Blender") from error


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def bounds():
    points = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or obj.name.startswith("COLLIDER_"):
            continue
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    if not points:
        raise ValueError("No renderable benchmark mesh")
    minimum = Vector(tuple(min(point[index] for point in points) for index in range(3)))
    maximum = Vector(tuple(max(point[index] for point in points) for index in range(3)))
    return minimum, maximum


def add_area(name, location, energy, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    look_at(obj, (0, 0, 0))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--prefix", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else [])
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 768
    scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.look = "Medium High Contrast"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("BlindWorld")
    scene.world.color = (0.025, 0.025, 0.025)
    for obj in list(scene.objects):
        if obj.type in {"LIGHT", "CAMERA"}:
            bpy.data.objects.remove(obj, do_unlink=True)
    minimum, maximum = bounds()
    center = (minimum + maximum) / 2
    size = maximum - minimum
    radius = max(size.length / 2, 0.5)
    camera_data = bpy.data.cameras.new("BlindCamera")
    camera_data.lens = 55
    camera = bpy.data.objects.new("BlindCamera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    add_area("BlindKey", center + Vector((radius * 2.2, -radius * 2.8, radius * 3.2)), 1200, radius * 2.5)
    add_area("BlindFill", center + Vector((-radius * 2.5, -radius, radius * 1.5)), 500, radius * 3)
    add_area("BlindRim", center + Vector((0, radius * 2.5, radius * 2.5)), 800, radius * 2)
    views = {
        "front": Vector((0, -3.2, 0.8)),
        "side": Vector((3.2, 0, 0.8)),
        "three-quarter": Vector((2.6, -2.6, 1.5)),
    }
    for name, direction in views.items():
        camera.location = center + direction.normalized() * radius * 3.4
        look_at(camera, center)
        scene.render.filepath = str(output / f"{args.prefix}-{name}.png")
        bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
