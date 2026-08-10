# blender-axi versus BlenderMCP benchmark

This package implements the executable benchmark specified by the 2026-07-30 Blender study. It is separate from production `src/` and the `blender-axi` CLI. It follows the useful ClickUp benchmark patterns: isolated arms, reset before every run, one append-only JSONL attempt record, deterministic-first grading, resume by completed cell ID, and task-clustered paired bootstrap analysis.

## Safety boundary

The benchmark owns only directories passed through `--runs`, process IDs written to each run's `owned-processes.json`, and unique ports selected from the frozen benchmark range. It never searches for, kills, or modifies arbitrary Blender processes. Port 9876 is treated as external and the preflight refuses when it has a listener; each cell exports `BLENDER_HOST`/`BLENDER_PORT` so the pinned BlenderMCP server addresses that cell's isolated Blender instead of its own 9876 default. Provider processes are spawned as their own process group and torn down by group with SIGKILL escalation, so no wrapper, MCP server, or Blender process survives success, failure, interrupt, or timeout. Fixture source files are copied read-only. Each cell gets a new run directory, HOME, state directory, workspace, output, transcript, logs, artifacts, process registry, and port.

Do not put a primary checkout, user Blender file, or shared Unity project under `--runs`. Never point `BLENDER_MCP_ADDON_PATH` at a modified addon. Generated `.blend`, `.fbx`, `.glb`, render, run, report, scorer, and Unity cache data is ignored by git.

## Pinning and setup

1. Install Node 20+ and dependencies: `npm ci`.
2. Build: `npm run build`.
3. Install Blender 5.2.0 LTS. Set `BLENDER_EXECUTABLE` if it is not `/Applications/Blender.app/Contents/MacOS/Blender`.
4. Put the unmodified BlenderMCP v1.2 `addon.py` outside this repository and set `BLENDER_MCP_ADDON_PATH`. Its required SHA-256 is `ca6955bb584d78e229f020a8b9d7011440adc6e94dab0ac8e01ab2794db19dc0`.
5. Review `benchmark/config/frozen.json`. Before live execution, freeze exact provider, model snapshot, effort, agent CLI, campaign wall limit, and exact Unity patch. Do not replace nulls with invented zeroes. Dollar cost is excluded from this benchmark: no rate sheet and no dollar ceiling are configured, `api_cost_usd` stays null unless the provider reports a strictly positive cost, and a catalog price of zero is never treated as free.
6. Stage every pinned toolchain the arms invoke outside `/Users/`, using the exact revisions in `benchmark/config/frozen.json`, and prove the staged files are byte-identical to artifacts built from those revisions before live execution. The transcript policy denies any tool event containing `/Users/`, and an agent that resolves a binary with `command -v` embeds its absolute path in later calls. Putting the directory on `PATH` is not sufficient.
7. Configure a provider-specific wrapper in `benchmark/config/agent-command.json`. It must start a fresh non-persistent session, disable ambient skills/hooks/MCPs, accept the full prompt on stdin, expose only the selected arm, emit provider JSONL on stdout, and preserve provider usage fields as null when unavailable. Spawn the wrapper as its own process-group leader and tear down the group on process exit and on `SIGTERM`, `SIGINT`, or `SIGHUP`; Pi print mode does not emit `session_end`, so cleanup cannot depend on that event. Clear request watchdog timers during teardown.
8. For P6, select an exact Unity Editor patch and URP package lock. FBX is the primary Unity artifact; GLB is the portable secondary artifact. Build a fresh minimal project generator that satisfies the `unity-urp-fbx-v1` contract. Unity is an explicit preflight requirement, not inferred from Blender or GLB validity.

## Fixtures

Generate local deterministic Blender fixtures:

```sh
npm run benchmark -- fixtures create --blender "$BLENDER_EXECUTABLE" --force
npm run benchmark -- fixtures verify
```

`benchmark/fixtures/manifest.json` records exact Blender executable hash, fixture contract hashes, artifact hashes, and extra supplied-file hashes. It is generated because `.blend` files are intentionally not committed. Task manifests P1-P6 are versioned in `benchmark/fixtures/tasks/` and contain exact prompts, immutable fixture hash linkage, timeout classes, required artifacts, and deterministic oracle definitions.

If a fixture, task manifest, Blender binary, or generator changes, regenerate fixtures and archive a new plan. Existing plans intentionally fail against a different manifest hash.

## Planning

The four-cell instrumentation plan contains P1 and P5 once per arm. Their arm order is opposite:

```sh
npm run benchmark -- plan preflight --output /tmp/blender-bench/preflight-plan.json --seed 4103
```

A full 60-cell pilot plan is generated but not run by this command:

```sh
npm run benchmark -- plan pilot --output /tmp/blender-bench/pilot-plan.json --seed 4103 --replicates 5
```

Plans are deterministic for a seed, counterbalanced within task/replicate blocks, randomized by block, sequential, and archived before execution. `run selected` requires explicit cell IDs. There is intentionally no unbounded `run all` shortcut.

## Offline preflight and the explicit four-paid-run command

Check fixtures, Blender, addon pin, safety ceilings, closed external port, and Unity contract without calling an agent:

```sh
npm run benchmark -- preflight check \
  --blender "$BLENDER_EXECUTABLE" \
  --addon "$BLENDER_MCP_ADDON_PATH"
```

The later four-run live instrumentation preflight is this exact explicit command:

```sh
npm run benchmark -- preflight execute \
  --plan /tmp/blender-bench/preflight-plan.json \
  --runs /tmp/blender-bench/preflight-runs \
  --blender "$BLENDER_EXECUTABLE" \
  --addon "$BLENDER_MCP_ADDON_PATH"
```

It refuses unless there are exactly four P1/P5 cells, the fixture manifest and frozen Blender/addon hashes match, provider credentials and exact model configuration exist, the adapter declares fresh-session and ambient-integration-disable arguments, the campaign wall limit is non-null, a Unity target is selected, and external port 9876 is closed. Dollar pricing is deliberately not a preflight requirement. Do not run this command in CI or while building benchmark machinery.

## Selected execution and resume

After preflight review and captain approval, run only explicitly selected archived cells:

```sh
npm run benchmark -- run selected \
  --plan /tmp/blender-bench/pilot-plan.json \
  --cells P1-seed-123-r01-axi,P1-seed-123-r01-mcp \
  --runs /tmp/blender-bench/pilot-runs \
  --blender "$BLENDER_EXECUTABLE" \
  --addon "$BLENDER_MCP_ADDON_PATH"
```

The runner appends one complete record to `results.jsonl` only after transcript capture and grading. On interruption, run the same command again. Existing `run_id` values are skipped, no duplicate cell is added, and incomplete directories without a durable record are preserved for inspection rather than silently treated as complete. Invalid attempts remain in JSONL. An infrastructure-invalid replacement must use a new run ID and populate `replacement_for`; the original record is never edited or removed.

The runner stops before the configured wall-time, invalid-attempt, or critical-failure ceilings. There is no dollar ceiling because cost is excluded; the campaign wall limit is the binding brake. Campaign execution is sequential. A cross-arm policy violation invalidates the attempt and contributes to the invalid ceiling.

## Run artifact layout

```text
<runs>/
  results.jsonl
  visual-scores.jsonl       append-only visual score sidecar
  <run_id>/
    attempt.json
    owned-processes.json
    fixture/                 read-only source copy
    workspace/               writable scripts
    output/                  requested outputs
    artifacts/               archived derivative evidence
    transcript/
      prompt.txt
      answer.txt
      full.txt
      provider.jsonl
      interface.jsonl
    logs/
      agent.stdout.log
      agent.stderr.log
      blender.stdout.log
      blender.stderr.log
    oracles/
      start-scene.json
      result-scene.json
      grade.json
      unity.json             only when pinned Unity harness ran
```

Records distinguish total first-turn context from marginal interface surface. They capture provider usage, cache use, normalized o200k counts, tool bytes and calls, nested tool events, turns, retries, request timing, paths, hashes, strictly positive provider-reported cost when available, outcomes, scores, validity, and replacement linkage. Provider-unavailable metrics are null. Secrets are removed from text and sensitive-key values before persistence.

## Deterministic grading

Grade existing attempts without asking an agent:

```sh
npm run benchmark -- grade --runs /tmp/blender-bench/pilot-runs --blender "$BLENDER_EXECUTABLE"
```

Hard checks run first: source preservation, required artifacts, clean reopen, scene facts, GLB validation, exchange round-trip evidence, P5 first failure, and Unity evidence where available. A final answer claim is recorded but never used as an oracle. Outcomes are `solved`, `wrong_artifact`, `damaging_failure`, `deferred`, `budget_exhausted`, `crashed`, `policy_violation`, or `infrastructure_invalid`. Deterministic failure cannot be overridden by a human, LLM judge, or visual score.

Residual LLM judging is not enabled by default. If added later, archive its prompt and response, use opaque IDs, hide arm/transcript/cost, and never permit it to alter a hard-check result.

## Blinded visual scoring

Generate opaque bundles and one CSV form for each of at least three raters:

```sh
npm run benchmark -- visual bundle \
  --runs /tmp/blender-bench/pilot-runs \
  --output /tmp/blender-bench/scoring \
  --blender "$BLENDER_EXECUTABLE" \
  --seed 9001
```

The bundle command reopens each valid `.blend` and renders fixed front, side, and three-quarter views with the same post-hoc camera, lights, resolution, color management, and CPU-compatible engine. Keep `PRIVATE-blind-map.json` from raters. Public manifests reveal only opaque IDs and image paths. Raters must complete six owner-approved calibration anchors before benchmark scores. Forms enforce the 100-point rubric and include 10% duplicate artifacts for stability. Set `calibration_complete=true` only after calibration.

Close scores only after every artifact has three or more independent raters and the duplicate/inter-rater agreement meets the frozen threshold:

```sh
npm run benchmark -- visual close \
  --scoring /tmp/blender-bench/scoring \
  --results /tmp/blender-bench/pilot-runs/results.jsonl
```

Do not unblind early. Closing appends visual results to `visual-scores.jsonl`; it never rewrites `results.jsonl`, and reporting joins the two datasets by `run_id`. Deterministic score, blinded visual score, scorer agreement, and Unity readiness remain separate outputs.

## Analysis and reports

```sh
npm run benchmark -- report \
  --results /tmp/blender-bench/pilot-runs/results.jsonl \
  --output /tmp/blender-bench/report
```

This generates `report.json`, `report.md`, `report.html`, and `summary.csv`. Analysis includes per-task/per-arm outcomes, unbiased pass^k, error composition, category-ready rows, task-clustered two-stage paired bootstrap intervals, AXI-minus-MCP deltas, frozen non-inferiority verdicts, optional provider-reported cost diagnostics, and interface-surface summaries. Dollar cost is excluded from conclusions; tokens and wall time carry the efficiency comparison. Capability-exclusive records are reported separately and excluded from shared-quality estimates. Quality and efficiency are never collapsed.

## Offline contributor proof

The following sequence must work without network, credentials, Unity, paid agents, or a live addon listener:

```sh
npm run benchmark -- fixtures create --blender "$BLENDER_EXECUTABLE" --force
npm run benchmark -- fixtures verify
npm run benchmark -- plan preflight --output /tmp/blender-bench/offline-plan.json --seed 4103
npm run benchmark -- simulate --plan /tmp/blender-bench/offline-plan.json --runs /tmp/blender-bench/offline-runs
npm run benchmark -- simulate --plan /tmp/blender-bench/offline-plan.json --runs /tmp/blender-bench/offline-runs
npm run benchmark -- grade --runs /tmp/blender-bench/offline-runs --blender "$BLENDER_EXECUTABLE"
npm run benchmark -- report --results /tmp/blender-bench/offline-runs/results.jsonl --output /tmp/blender-bench/offline-report
```

The second simulation proves resume behavior and duplicate-cell avoidance. Synthetic attempts can fail deterministic oracles; that is expected. The objective is a complete reproducible instrumentation path without live services.
