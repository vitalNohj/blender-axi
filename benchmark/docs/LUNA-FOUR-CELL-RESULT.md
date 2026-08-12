# Frozen four-cell Luna result

This is the concise public result record for one frozen, independently verified comparison of Blender AXI and BlenderMCP. The benchmark package's [methodology, safety, isolation, grading, and reporting contract](BENCHMARK.md) remains authoritative.

## Frozen conditions

| Field | Value |
| --- | --- |
| Model | `codex-lb/gpt-5.6-luna` |
| Reasoning effort | `xhigh` |
| Tasks | P1 precise scene edit; P5 first-failure diagnosis and recovery |
| Attempts | One per condition; four cells total; no retries |
| Dispatch | Strictly sequential; each port released before the next cell |
| Inputs | Frozen prompts and byte-identical paired fixtures |
| Cell timeout | 600 seconds |
| Interface policy | AXI cells used shell only; MCP cells used BlenderMCP tools only |

P1 required an exact object rename, dimensions, placement, applied scale, material, color, and scene preservation before saving a `.blend`. P5 required running a read-only faulty script once, diagnosing the exact first failure, repairing a copy, completing the intended mesh, cleaning failed-attempt residue, preserving unrelated state, and saving a recovered `.blend`. The versioned task contracts are [`P1.json`](../fixtures/tasks/P1.json) and [`P5.json`](../fixtures/tasks/P5.json).

## Result

| Cell | Interface | Outcome | Wall time | Required artifact |
| --- | --- | --- | ---: | --- |
| P1 | BlenderMCP | Incorrect: no artifact; final answer claimed a save that failed | 102 s | Missing |
| P1 | Blender AXI | Fully correct | 93 s | Valid |
| P5 | Blender AXI | Fully correct | 301 s | Valid |
| P5 | BlenderMCP | Incorrect at timeout: defect remained and recovered geometry was wrong | 600 s | Present but invalid |

**Blender AXI completed 2/2 tasks correctly and produced 2/2 valid required artifacts. BlenderMCP completed 0/2 tasks correctly and produced 0/2 valid required artifacts.**

### Aggregate efficiency

| Measure | Blender AXI | BlenderMCP | AXI difference |
| --- | ---: | ---: | ---: |
| Total wall time | 394 s | 702 s | 43.9% less |
| Input tokens | 84,503 | 80,924 | 4.4% more |
| Output tokens | 19,610 | 35,295 | 44.4% fewer |
| Combined input + output tokens | 104,113 | 116,219 | 10.4% fewer |
| Reasoning tokens | 15,658 | 21,947 | 28.7% fewer |
| Provider/load-balancer cost proxy | 0.040729 | 0.058815 | 30.8% lower |

Reasoning tokens are included within output tokens, not additive. Usage was de-duplicated from final assistant-turn events because the provider stream echoed the same usage in multiple event types.

The provider/load-balancer cost values are retained only as a **relative self-reported proxy**. They are not dollars and are not measured or independently verified billing cost.

Percentages use the BlenderMCP total as the denominator:

```text
wall time       (702 - 394) / 702       = 43.9%
combined tokens (116219 - 104113) / 116219 = 10.4%
output tokens   (35295 - 19610) / 35295 = 44.4%
reasoning       (21947 - 15658) / 21947 = 28.7%
cost proxy      (0.058815 - 0.040729) / 0.058815 = 30.8%
```

## Verification evidence

Independent artifact inspection established the following:

- **P1 AXI:** the required object dimensions, applied scale, bottom placement, single named material, linearized source color, camera, and light all matched the deterministic contract.
- **P1 MCP:** both save attempts targeted the read-only fixture directory and failed with permission errors. No required artifact existed despite the final success claim.
- **P5 AXI:** the repaired copy corrected the indexed-edge defect and produced the intended 3-vertex, 3-edge, 1-polygon triangle. Failed-attempt residue was removed and unrelated scene state remained unchanged.
- **P5 MCP:** the supplied defect remained in the repaired script. Added code bypassed it by creating unrelated 8-vertex, 12-edge, 6-polygon cube geometry. The required artifact existed but failed the task contract.
- The P1 fixture was byte-identical across its two cells. The P5 `.blend` and faulty script were byte-identical across their two cells and unchanged after execution.
- Interface-event inspection found no cross-arm tool-policy violations.

Artifact existence alone was not accepted as success. Verification reopened Blender files and compared scene facts with the intended deterministic result. A final answer claim was never used as an oracle.

## Conclusion and limits

Under these frozen conditions Blender AXI produced more accurate results with less elapsed time, fewer generated tokens, and a lower provider-reported cost proxy than BlenderMCP.

> [!WARNING]
> This result has `n=1` per cell: two prompts, one model and effort level, and one machine. Cell 4 confounds interface arm with timeout, so those effects cannot be separated. This is a controlled signal for these scenarios, not statistical proof of universal superiority or raw transport speed.

No raw tool-latency benchmark was performed. No fifth cell or retry is included in this result.
