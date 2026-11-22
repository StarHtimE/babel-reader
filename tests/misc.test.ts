import { describe, expect, it } from "vitest";
import { bytesToHex, sha256Hex } from "../src/core/hash";
import { formatProgress } from "../src/core/progress";
import { buildJobOptions, DEFAULT_SETTINGS, mergeSettings } from "../src/core/settings-model";
import { buildApiUrl, normalizeServerUrl } from "../src/core/url";

describe("url", () => {
	it("规范化服务地址", () => {
		expect(normalizeServerUrl(" http://127.0.0.1:8891/ ")).toBe("http://127.0.0.1:8891");
		expect(normalizeServerUrl("https://h.local/babel/")).toBe("https://h.local/babel");
		expect(normalizeServerUrl("ftp://x")).toBeNull();
		expect(normalizeServerUrl("not a url")).toBeNull();
		expect(normalizeServerUrl("http://h/?a=1")).toBeNull();
		expect(normalizeServerUrl("")).toBeNull();
	});

	it("拼接接口路径", () => {
		expect(buildApiUrl("http://127.0.0.1:8891/", "/jobs/abc")).toBe("http://127.0.0.1:8891/v1/jobs/abc");
		expect(buildApiUrl("http://h/base", "health")).toBe("http://h/base/v1/health");
		expect(() => buildApiUrl("bad", "/health")).toThrow();
	});
});

describe("hash", () => {
	it("SHA-256", async () => {
		const data = new TextEncoder().encode("abc");
		expect(await sha256Hex(data.buffer)).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(bytesToHex(new Uint8Array([0, 255]))).toBe("00ff");
	});
});

describe("settings", () => {
	it("合并设置时丢弃类型不对的字段", () => {
		const s = mergeSettings({ serverUrl: "http://x", generateDual: "yes", extra: 1 });
		expect(s.serverUrl).toBe("http://x");
		expect(s.generateDual).toBe(true);
		expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});

	it("构造任务 options：禁用交替页、默认不忽略缓存", () => {
		const o = buildJobOptions({ ...DEFAULT_SETTINGS, profile: " ", generateDual: false });
		expect(o).toEqual({
			lang_in: "en",
			lang_out: "zh",
			profile: null,
			llm: null,
			pages: null,
			outputs: ["mono"],
			dual_translate_first: false,
			ignore_cache: false,
			glossary_csv: null,
			auto_extract_glossary: true,
		});
		expect(buildJobOptions(DEFAULT_SETTINGS).outputs).toEqual(["mono", "dual"]);
	});
});

describe("progress", () => {
	it("状态栏文案", () => {
		expect(formatProgress({ state: "queued", stage: null, stage_progress: 0, overall_progress: 0 })).toBe(
			"排队中",
		);
		expect(
			formatProgress({ state: "running", stage: "Translate", stage_progress: 10, overall_progress: 42.9 }),
		).toBe("42% · Translate");
	});
});

describe("术语表参数", () => {
	it("带上术语表 CSV 和自动抽取开关", () => {
		const o = buildJobOptions({ ...DEFAULT_SETTINGS, autoExtractGlossary: false }, { glossary_csv: "source,target\n" });
		expect(o.glossary_csv).toBe("source,target\n");
		expect(o.auto_extract_glossary).toBe(false);
	});
});
