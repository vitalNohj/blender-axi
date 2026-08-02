import bpy  # type: ignore[import-not-found]

for step in range(80):
    print(f"progress {step + 1:02d}/80")

mesh = bpy.data.meshes.new("TemporaryBrokenMesh")
temporary = bpy.data.objects.new("HalfBuiltTemporary", mesh)
bpy.context.scene.collection.objects.link(temporary)
mesh.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [], [])


def connect_recovered_edges(target_mesh):
    target_mesh.edges[17].select = True


def assemble_recovered_part(target_mesh):
    connect_recovered_edges(target_mesh)


assemble_recovered_part(mesh)
temporary.name = "RecoveredPart"
