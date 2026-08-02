#!/usr/bin/env python3
"""Import an exchange artifact in factory Blender and emit round-trip facts."""

import argparse
import json
import sys
from pathlib import Path

try:
    import bpy  # type: ignore[import-not-found]
except ImportError as error:
    raise SystemExit("Run this script through Blender") from error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allowed-root", required=True)
    script_args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parser.parse_args(script_args)
    source = Path(args.input).resolve()
    output = Path(args.output).resolve()
    allowed_root = Path(args.allowed_root).resolve()
    if not source.is_relative_to(allowed_root) or not output.is_relative_to(allowed_root):
        raise SystemExit(f"Input and output must stay under {allowed_root}")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    extension = source.suffix.lower()
    try:
        if extension in {".glb", ".gltf"}:
            bpy.ops.import_scene.gltf(filepath=str(source))
        elif extension == ".fbx":
            bpy.ops.wm.fbx_import(filepath=str(source))
        else:
            raise ValueError(f"Unsupported round-trip extension: {extension}")
    except Exception as error:
        result = {"ok": False, "error": f"{type(error).__name__}: {error}", "objects": [], "meshes": 0}
    else:
        result = {
            "ok": True,
            "error": None,
            "objects": sorted(obj.name for obj in bpy.context.scene.objects),
            "meshes": sum(1 for obj in bpy.context.scene.objects if obj.type == "MESH"),
        }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
