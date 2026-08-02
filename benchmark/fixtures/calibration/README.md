# Oracle and visual calibration contracts

Calibration data is generated locally because Blender and render artifacts are not committed.

- `known-good/P1`: generated from `P1.fixture.json`, then modified to satisfy every P1 oracle.
- `known-bad/P1`: a copy that keeps `SourceCube`, wrong dimensions, and no `CrateBlue` material.
- `known-good/export`: a minimal valid mesh exported by pinned Blender to GLB and FBX, then re-imported.
- `known-bad/export`: deterministic truncated GLB and non-FBX byte fixtures.
- `known-good/P5`: first-failure transcript with all 80 progress lines and exact `connect_recovered_edges` line, repaired script, preserved marker, and clean result.
- `known-bad/P5`: missing first failure, changed marker, or half-built temporary object.
- Visual calibration requires six benchmark-owner-approved image anchors spanning clear failure through excellent. Arm, transcript, and cost metadata must never be included.
- Unity calibration is blocked until the exact editor patch and URP package lock are frozen. Its generator contract is `fixtures/specs/P6.fixture.json` and `config/frozen.json`. Known-good and known-bad import artifacts must be generated in the selected editor before P6 live execution.

The offline test suite creates small synthetic forms, transcripts, corrupted fixture bytes, and result records in temporary directories. `npm run benchmark:test` never uses live Blender, Unity, network, credentials, or paid models.
