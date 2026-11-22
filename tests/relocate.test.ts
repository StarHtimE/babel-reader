import { describe, expect, it } from "vitest";
import type { TranslationManifest } from "../src/core/manifest";
import { titleToFileName, uniqueFileName } from "../src/core/naming";
import { movedSourcePath, planRelocation } from "../src/core/relocate";
import { TranslationIndex, type TranslationEntry } from "../src/core/translation-index";

function entry(dir: string, source: string, outputs: TranslationManifest["outputs"]): TranslationEntry {
	return {
		manifestPath: `${dir}/manifest.json`,
		manifest: {
			schema: 1,
			id: "abc123",
			source: { path: source, sha256: "0".repeat(64) },
			lang: { in: "en", out: "zh" },
			outputs,
			options: { pages: null, profile: null, glossary: null },
			engine: { server: "", pdf2zh_next: "", babeldoc: "" },
			createdAt: "2026-11-20T00:00:00Z",
		},
	};
}

const GENERATED = entry("_translations/2108.13342v2-abc123", "Papers/2108.13342v2.pdf", {
	mono: "2108.13342v2.zh.mono.pdf",
	dual: "2108.13342v2.zh.dual.pdf",
});

describe("titleToFileName", () => {
	it("替换文件名和链接里不允许的字符", () => {
		expect(titleToFileName("Despeckling: A Review")).toBe("Despeckling - A Review");
		expect(titleToFileName('Input/Output | "Fast" [v2] #1?')).toBe("Input-Output-'Fast' (v2) 1");
		expect(titleToFileName("A\\B<C>*")).toBe("A-BC");
		expect(titleToFileName("基于深度学习的去噪：综述")).toBe("基于深度学习的去噪 - 综述");
		expect(titleToFileName("  ...  ")).toBeNull();
		expect(titleToFileName("CON")).toBe("CON_");
		expect(titleToFileName("Ends with dots...")).toBe("Ends with dots");
	});

	it("超长时在词边界截断", () => {
		const name = titleToFileName("word ".repeat(40), 50);
		expect(name).toBe("word word word word word word word word word word");
		expect(titleToFileName("x".repeat(80), 50)).toHaveLength(50);
	});
});

describe("uniqueFileName", () => {
	it("重名时加序号，按大小写不敏感比较", () => {
		const taken = new Set(["a.pdf", "a (2).pdf"]);
		const isTaken = (n: string) => taken.has(n.toLowerCase());
		expect(uniqueFileName("b", ".pdf", isTaken)).toBe("b.pdf");
		expect(uniqueFileName("A", ".pdf", isTaken)).toBe("A (3).pdf");
	});
});

describe("planRelocation", () => {
	const nothing = () => false;
	const existing = (paths: string[]) => (p: string) => paths.includes(p);
	const outputsExist = existing([
		"_translations/2108.13342v2-abc123/2108.13342v2.zh.mono.pdf",
		"_translations/2108.13342v2-abc123/2108.13342v2.zh.dual.pdf",
	]);

	it("改名时译文目录和文件一起改名", () => {
		const plan = planRelocation(GENERATED, "Papers/Attention Is All You Need.pdf", "_translations", outputsExist);
		expect(plan.fileRenames).toEqual([
			{
				kind: "mono",
				from: "_translations/2108.13342v2-abc123/2108.13342v2.zh.mono.pdf",
				to: "_translations/2108.13342v2-abc123/Attention Is All You Need.zh.mono.pdf",
			},
			{
				kind: "dual",
				from: "_translations/2108.13342v2-abc123/2108.13342v2.zh.dual.pdf",
				to: "_translations/2108.13342v2-abc123/Attention Is All You Need.zh.dual.pdf",
			},
		]);
		expect(plan.dirRename).toEqual({
			from: "_translations/2108.13342v2-abc123",
			to: "_translations/Attention Is All You Need-abc123",
		});
		expect(plan.manifestPath).toBe("_translations/Attention Is All You Need-abc123/manifest.json");
		expect(plan.manifest.source.path).toBe("Papers/Attention Is All You Need.pdf");
		expect(plan.manifest.outputs.mono).toBe("Attention Is All You Need.zh.mono.pdf");
		// 不修改原来的对象
		expect(GENERATED.manifest.source.path).toBe("Papers/2108.13342v2.pdf");
	});

	it("只移动位置、不改文件名时只更新原文路径", () => {
		const plan = planRelocation(GENERATED, "Archive/2108.13342v2.pdf", "_translations", outputsExist);
		expect(plan.fileRenames).toEqual([]);
		expect(plan.dirRename).toBeNull();
		expect(plan.manifestPath).toBe(GENERATED.manifestPath);
		expect(plan.manifest.source.path).toBe("Archive/2108.13342v2.pdf");
	});

	it("用户改过的目录名、文件名不动；目标已存在时跳过", () => {
		const custom = entry("_translations/my-folder", "Papers/2108.13342v2.pdf", { mono: "2108.13342v2.zh.mono.pdf" });
		const a = planRelocation(custom, "Papers/New.pdf", "_translations", nothing);
		expect(a.fileRenames).toEqual([]);
		expect(a.dirRename).toBeNull();

		const renamedFile = entry("_translations/2108.13342v2-abc123", "Papers/2108.13342v2.pdf", { mono: "mine.pdf" });
		const b = planRelocation(renamedFile, "Papers/New.pdf", "_translations", () => true);
		expect(b.fileRenames).toEqual([]);
		expect(b.dirRename).toBeNull();
		expect(b.manifest.outputs.mono).toBe("mine.pdf");

		// 译文目录不在设置的译文目录里：不改名
		const c = planRelocation(GENERATED, "Papers/New.pdf", "Other", outputsExist);
		expect(c.dirRename).toBeNull();
	});

	it("文件夹改名时算出原文的新路径", () => {
		expect(movedSourcePath("Papers/a.pdf", "Papers/a.pdf", "Papers/b.pdf")).toBe("Papers/b.pdf");
		expect(movedSourcePath("Papers/x/a.pdf", "Papers", "Refs")).toBe("Refs/x/a.pdf");
		expect(movedSourcePath("Papers2/a.pdf", "Papers", "Refs")).toBeNull();
	});
});

describe("TranslationIndex.entriesUnderSource", () => {
	it("按原文路径或所在文件夹查找", () => {
		const index = new TranslationIndex();
		index.set(GENERATED);
		index.set(entry("_translations/b-abc124", "Papers2/b.pdf", { mono: "b.zh.mono.pdf" }));
		expect(index.entriesUnderSource("Papers").map((e) => e.manifestPath)).toEqual([GENERATED.manifestPath]);
		expect(index.entriesUnderSource("Papers/2108.13342v2.pdf")).toHaveLength(1);
		expect(index.entriesUnderSource("Pap")).toHaveLength(0);
	});
});
