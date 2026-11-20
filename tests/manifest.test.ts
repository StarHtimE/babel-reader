import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/core/errors";
import { parseManifest, serializeManifest, type TranslationManifest } from "../src/core/manifest";

const SHA = "a".repeat(64);

function sample(): Record<string, unknown> {
	return {
		schema: 1,
		id: "a1b2c3",
		source: { path: "Papers/xxx.pdf", sha256: SHA },
		lang: { in: "en", out: "zh" },
		outputs: { mono: "xxx.zh.mono.pdf", dual: "xxx.zh.dual.pdf" },
		options: { pages: null, profile: "deepseek", glossary: null },
		engine: { server: "0.1.0", pdf2zh_next: "2.10.2", babeldoc: "0.7.1" },
		createdAt: "2026-11-20T12:00:00Z",
	};
}

describe("manifest", () => {
	it("解析合法 manifest 并可往返序列化", () => {
		const m = parseManifest(sample());
		expect(m.outputs.dual).toBe("xxx.zh.dual.pdf");
		const again: TranslationManifest = parseManifest(JSON.parse(serializeManifest(m)));
		expect(again).toEqual(m);
	});

	it("只有 mono 时也合法", () => {
		const data = sample();
		data.outputs = { mono: "xxx.zh.mono.pdf" };
		expect(parseManifest(data).outputs).toEqual({ mono: "xxx.zh.mono.pdf" });
	});

	it("忽略未知的输出种类，缺省 options/engine 时补默认值", () => {
		const data = sample();
		data.outputs = { mono: "m.pdf", epub: "x.epub" };
		delete data.options;
		delete data.engine;
		const m = parseManifest(data);
		expect(m.outputs).toEqual({ mono: "m.pdf" });
		expect(m.options).toEqual({ pages: null, profile: null, glossary: null });
		expect(m.engine.server).toBe("");
	});

	it("拒绝不合法的数据", () => {
		const cases: [string, (d: Record<string, unknown>) => void][] = [
			["schema 过新", (d) => (d.schema = 2)],
			["缺 schema", (d) => delete d.schema],
			["id 格式", (d) => (d.id = "XYZ")],
			["sha256 格式", (d) => (d.source = { path: "a.pdf", sha256: "abc" })],
			["outputs 含路径", (d) => (d.outputs = { mono: "../evil.pdf" })],
			["outputs 为空", (d) => (d.outputs = {})],
			["缺 createdAt", (d) => delete d.createdAt],
		];
		for (const [label, mutate] of cases) {
			const data = sample();
			mutate(data);
			expect(() => parseManifest(data), label).toThrow(ValidationError);
		}
	});

	it("schema 过新时提示升级插件", () => {
		const data = sample();
		data.schema = 9;
		expect(() => parseManifest(data)).toThrow(/升级插件/);
	});
});
