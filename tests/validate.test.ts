import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/core/errors";
import { parseHealth, parseJobCreated, parseJobStatus, parseProfiles } from "../src/core/validate";

describe("服务响应校验", () => {
	it("health", () => {
		const h = parseHealth({
			ok: true,
			server_version: "0.1.0",
			pdf2zh_next_version: "2.10.2",
			babeldoc_version: "0.7.1",
		});
		expect(h.babeldoc_version).toBe("0.7.1");
		expect(() => parseHealth({ ok: false })).toThrow(ValidationError);
		expect(() => parseHealth("ok")).toThrow(ValidationError);
	});

	it("profiles", () => {
		expect(parseProfiles({ profiles: ["deepseek", "local"] })).toEqual(["deepseek", "local"]);
		expect(() => parseProfiles({ profiles: [1] })).toThrow(ValidationError);
		expect(() => parseProfiles(["deepseek"])).toThrow(ValidationError);
	});

	it("job_id", () => {
		expect(parseJobCreated({ job_id: "abc_123-x" })).toBe("abc_123-x");
		expect(() => parseJobCreated({ job_id: "../etc" })).toThrow(ValidationError);
		expect(() => parseJobCreated({})).toThrow(ValidationError);
	});

	it("job status", () => {
		const s = parseJobStatus({
			state: "running",
			stage: "Translate Paragraphs",
			stage_progress: 50,
			overall_progress: 120,
		});
		expect(s.state).toBe("running");
		expect(s.overall_progress).toBe(100);
		expect(s.outputs).toBeUndefined();

		const done = parseJobStatus({
			state: "done",
			stage: null,
			stage_progress: 100,
			overall_progress: 100,
			error: null,
			outputs: ["mono", "dual"],
		});
		expect(done.outputs).toEqual(["mono", "dual"]);
		expect(done.error).toBeUndefined();

		expect(() =>
			parseJobStatus({ state: "weird", stage: null, stage_progress: 0, overall_progress: 0 }),
		).toThrow(ValidationError);
		expect(() =>
			parseJobStatus({
				state: "done",
				stage: null,
				stage_progress: 0,
				overall_progress: 0,
				outputs: ["pdf"],
			}),
		).toThrow(ValidationError);
	});
});
