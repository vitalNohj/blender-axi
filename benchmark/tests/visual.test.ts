import { describe, expect, it } from "vitest";
import { aggregateVisualScores } from "../src/visual.js";

const score = (rater: string, id = "OPAQUE") => ({
	rater_id: rater,
	opaque_id: id,
	calibration_complete: true,
	brief_adherence: 20,
	silhouette_role_readability: 20,
	form_proportion: 15,
	material_value_readability: 15,
	finish_defect_control: 15,
	composition_framing: 10,
	distinctiveness: 5,
	comments: "",
});

describe("visual scoring", () => {
	it("requires three calibrated independent raters and preserves separate score", () => {
		expect(() => aggregateVisualScores([score("A"), score("B")], 3)).toThrow(
			/requires 3/u,
		);
		expect(
			aggregateVisualScores([score("A"), score("B"), score("C")], 3),
		).toEqual({ OPAQUE: { mean: 100, rater_count: 3 } });
	});
});
