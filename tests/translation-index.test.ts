import { describe, expect, it } from "vitest";
import type { TranslationManifest } from "../src/core/manifest";
import { pathForMode, TranslationIndex, type TranslationEntry } from "../src/core/translation-index";

function entry(dir: string, source: string, out: string, createdAt: string, dual = true): TranslationEntry {
	const manifest: TranslationManifest = {
		schema: 1,
		id: "a1b2c3",
		source: { path: source, sha256: "0".repeat(64) },
		lang: { in: "en", out },
		outputs: dual ? { mono: `p.${out}.mono.pdf`, dual: `p.${out}.dual.pdf` } : { mono: `p.${out}.mono.pdf` },
		options: { pages: null, profile: null, glossary: null },
		engine: { server: "", pdf2zh_next: "", babeldoc: "" },
		createdAt,
	};
	return { manifestPath: `${dir}/manifest.json`, manifest };
}

describe("TranslationIndex", () => {
	it("原文 ⇄ 译文双向查询", () => {
		const idx = new TranslationIndex();
		const e = entry("_t/p-a1b2c3", "Papers/p.pdf", "zh", "2026-11-20T00:00:00Z");
		idx.set(e);

		expect(idx.resolve("Papers/p.pdf")).toEqual({ entry: e, mode: "original" });
		expect(idx.resolve("_t/p-a1b2c3/p.zh.mono.pdf")).toEqual({ entry: e, mode: "mono" });
		expect(idx.resolve("_t/p-a1b2c3/p.zh.dual.pdf")).toEqual({ entry: e, mode: "dual" });
		expect(idx.resolve("Papers/other.pdf")).toBeUndefined();
		expect(idx.isOutputPath("_t/p-a1b2c3/p.zh.mono.pdf")).toBe(true);

		expect(pathForMode(e, "original")).toBe("Papers/p.pdf");
		expect(pathForMode(e, "dual")).toBe("_t/p-a1b2c3/p.zh.dual.pdf");
	});

	it("没有 dual 时 pathForMode 返回 null", () => {
		const e = entry("_t/p-a1b2c3", "p.pdf", "zh", "2026-11-20T00:00:00Z", false);
		expect(pathForMode(e, "dual")).toBeNull();
	});

	it("多组译文时优先匹配目标语言，其次取最新", () => {
		const idx = new TranslationIndex();
		const zh = entry("_t/zh", "p.pdf", "zh", "2026-01-01T00:00:00Z");
		const ja = entry("_t/ja", "p.pdf", "ja", "2026-06-01T00:00:00Z");
		idx.set(zh);
		idx.set(ja);
		expect(idx.forSource("p.pdf", "zh")).toBe(zh);
		expect(idx.forSource("p.pdf", "fr")).toBe(ja);
		expect(idx.forSource("p.pdf")).toBe(ja);
	});

	it("删除整个译文目录时移除其下所有条目", () => {
		const idx = new TranslationIndex();
		idx.set(entry("_t/a-111111", "a.pdf", "zh", "2026-01-01T00:00:00Z"));
		idx.set(entry("_t/b-222222", "b.pdf", "zh", "2026-01-01T00:00:00Z"));
		idx.set(entry("_t2/c-333333", "c.pdf", "zh", "2026-01-01T00:00:00Z"));

		expect(idx.touches("_t/a-111111")).toBe(true);
		expect(idx.touches("_t/a-111111/p.zh.mono.pdf")).toBe(true);
		expect(idx.touches("_t/a")).toBe(false); // 只按完整路径段匹配
		expect(idx.touches("a.pdf")).toBe(false); // 原文不算

		expect(idx.removeUnder("_t/a-111111")).toBe(1);
		expect(idx.resolve("a.pdf")).toBeUndefined();
		expect(idx.removeUnder("_t")).toBe(1);
		expect(idx.resolve("c.pdf")?.mode).toBe("original");
		expect(idx.removeUnder("_t2/c-333333/manifest.json")).toBe(1);
		expect(idx.size).toBe(0);
	});

	it("覆盖与删除", () => {
		const idx = new TranslationIndex();
		idx.set(entry("_t/x", "old.pdf", "zh", "2026-01-01T00:00:00Z"));
		// 同一 manifest 改了原文路径：旧原文的反查要消失
		idx.set(entry("_t/x", "new.pdf", "zh", "2026-01-02T00:00:00Z"));
		expect(idx.size).toBe(1);
		expect(idx.resolve("old.pdf")).toBeUndefined();
		expect(idx.resolve("new.pdf")?.mode).toBe("original");

		idx.remove("_t/x/manifest.json");
		expect(idx.size).toBe(0);
		expect(idx.resolve("_t/x/p.zh.mono.pdf")).toBeUndefined();
		expect(idx.entriesForSource("new.pdf")).toEqual([]);
	});
});
