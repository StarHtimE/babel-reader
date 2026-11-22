import { describe, expect, it } from "vitest";
import {
	appendPendingTerms,
	filterExtractedTerms,
	mergeGlossaries,
	newGlossaryNote,
	parseGlossaryCsv,
	parseGlossaryNote,
	toGlossaryCsv,
} from "../src/core/glossary";

const NOTE = [
	"# 术语表",
	"",
	"说明文字 | 不是表格",
	"",
	"| 原文 | 译文 | 目标语言 |",
	"| :--- | --- | --- |",
	"| speckle | 相干斑 | |",
	"| **SAR** | `SAR` | zh |",
	"| a \\| b | 甲或乙 | |",
	"| empty |  | |",
	"| despeckling | 去斑 | ja |",
	"",
	"```",
	"| code | 代码块里的表格 |",
	"| --- | --- |",
	"| x | y |",
	"```",
	"",
	"## 待审核",
	"",
	"| 原文 | 译文 | 来源 |",
	"| --- | --- | --- |",
	"| backscatter | 后向散射 | [[a.pdf]] |",
	"",
	"## 其他",
	"",
	"| term | translation |",
	"|---|---|",
	"| polarimetry | 极化测量 |",
].join("\n");

describe("parseGlossaryNote", () => {
	it("读出表格里的术语，跳过代码块和「待审核」小节", () => {
		const { terms, knownSources } = parseGlossaryNote(NOTE);
		expect(terms).toEqual([
			{ source: "speckle", target: "相干斑", lang: null },
			{ source: "SAR", target: "SAR", lang: "zh" },
			{ source: "a | b", target: "甲或乙", lang: null },
			{ source: "despeckling", target: "去斑", lang: "ja" },
			{ source: "polarimetry", target: "极化测量", lang: null },
		]);
		expect(knownSources.has("backscatter")).toBe(true);
		expect(knownSources.has("x")).toBe(false);
	});

	it("表头认不出时用前两列", () => {
		const { terms } = parseGlossaryNote("| A | B |\n|---|---|\n| foo | 富 |\n");
		expect(terms).toEqual([{ source: "foo", target: "富", lang: null }]);
	});
});

describe("mergeGlossaries / toGlossaryCsv", () => {
	it("后面的覆盖前面的，按目标语言过滤", () => {
		const global = [
			{ source: "Speckle", target: "斑点", lang: null },
			{ source: "despeckling", target: "去斑", lang: "ja" },
		];
		const folder = [{ source: "speckle", target: "相干斑", lang: "zh" }];
		const merged = mergeGlossaries([global, folder], "zh");
		expect(merged).toEqual([{ source: "speckle", target: "相干斑", lang: "zh" }]);
		expect(mergeGlossaries([global], "zh-CN")).toHaveLength(1);
	});

	it("CSV 正确转义，空表不发送", () => {
		expect(toGlossaryCsv([])).toBeNull();
		expect(
			toGlossaryCsv([
				{ source: 'a, "b"', target: "甲", lang: null },
				{ source: "SAR", target: "合成孔径雷达", lang: "zh" },
			]),
		).toBe('source,target,tgt_lng\n"a, ""b""",甲,\nSAR,合成孔径雷达,zh\n');
	});

	it("解析上游返回的 CSV（BOM、引号、CRLF）", () => {
		const csv = '\uFEFFsource,target,tgt_lng\r\n"a, b",甲,zh\r\nSAR,"多\n行",\r\n,空,\r\n';
		expect(parseGlossaryCsv(csv)).toEqual([
			{ source: "a, b", target: "甲", lang: "zh" },
			{ source: "SAR", target: "多\n行", lang: null },
		]);
		expect(parseGlossaryCsv("x,y\n1,2\n")).toEqual([]);
	});
});

describe("filterExtractedTerms", () => {
	const t = (source: string, target: string) => ({ source, target, lang: null });

	it("去掉原文译文相同、没有字母、单复数重复、已有的", () => {
		const out = filterExtractedTerms(
			[
				t("DNN", "DNN"),
				t("Wei Niu", "Wei  niu"),
				t("DNNs", "DNN"),
				t("operator", "算子"),
				t("operators", "算子"),
				t("libraries", "库"),
				t("Deep Neural Networks", "深度神经网络"),
				t("deep neural network", "深度神经网络"),
				t("PLDI '21", "PLDI '21"),
				t("2021", "2021年"),
				t("class", "类"),
				t("analysis", "分析"),
				t("speckle", "相干斑"),
				t("Operator", "重复"),
				t("graph rewriting", "图重写"),
			],
			new Set(["speckle", "library"]),
		);
		expect(out.map((x) => x.source)).toEqual(["operator", "deep neural network", "class", "analysis", "graph rewriting"]);
	});
});

describe("appendPendingTerms", () => {
	const t = (source: string, target: string) => ({ source, target, lang: null });

	it("没有「待审核」小节时在末尾新建，按论文分子标题", () => {
		const { text, added } = appendPendingTerms(newGlossaryNote(), [t("speckle", "相干斑")], "[[论文.pdf]]");
		expect(added).toBe(1);
		expect(text.endsWith("## 待审核\n\n> 翻译时自动抽取的术语，还没有生效。确认无误后挪到上面的表格里；不需要的直接删掉。\n\n### 来自 [[论文.pdf]]\n\n| 原文 | 译文 |\n| --- | --- |\n| speckle | 相干斑 |\n")).toBe(true);
		// 新加的术语在待审核里，不生效
		expect(parseGlossaryNote(text).terms).toEqual([]);
	});

	it("新的一篇加在待审核小节末尾；跳过已有的原文", () => {
		const { text, added } = appendPendingTerms(
			NOTE,
			[t("Speckle", "x"), t("BACKSCATTER", "y"), t("incidence angle", "入射角"), t("incidence angle", "重复")],
			"[[b.pdf]]",
		);
		expect(added).toBe(1);
		const lines = text.split("\n");
		const at = lines.indexOf("| backscatter | 后向散射 | [[a.pdf]] |");
		expect(lines.slice(at + 1, at + 8)).toEqual([
			"",
			"### 来自 [[b.pdf]]",
			"",
			"| 原文 | 译文 |",
			"| --- | --- |",
			"| incidence angle | 入射角 |",
			"",
		]);
		expect(lines[at + 8]).toBe("## 其他");
		// 子标题下的仍然不生效，后面的小节不受影响
		const sources = parseGlossaryNote(text).terms.map((x) => x.source);
		expect(sources).not.toContain("incidence angle");
		expect(sources).toContain("polarimetry");
	});

	it("同一篇再次写回时追加到它的表格", () => {
		const first = appendPendingTerms(NOTE, [t("incidence angle", "入射角")], "[[b.pdf]]").text;
		const second = appendPendingTerms(first, [t("look angle", "视角")], "[[c.pdf]]").text;
		const { text, added } = appendPendingTerms(second, [t("azimuth", "方位向")], "[[b.pdf]]");
		expect(added).toBe(1);
		const lines = text.split("\n");
		const at = lines.indexOf("| incidence angle | 入射角 |");
		expect(lines[at + 1]).toBe("| azimuth | 方位向 |");
		expect(lines.filter((l) => l === "### 来自 [[b.pdf]]")).toHaveLength(1);
	});

	it("有「待审核」标题但没有表格时补上；竖线转义", () => {
		const note = "# 术语表\n\n## 待审核\n\n## 别的\n";
		const { text } = appendPendingTerms(note, [t("a|b", "甲")], "x");
		expect(text).toBe("# 术语表\n\n## 待审核\n\n### 来自 x\n\n| 原文 | 译文 |\n| --- | --- |\n| a\\|b | 甲 |\n\n## 别的\n");
	});

	it("待审核是六级标题时用普通一行区分论文，仍不生效", () => {
		const note = "###### 待审核\n";
		const once = appendPendingTerms(note, [t("a", "甲")], "x").text;
		expect(once).toBe("###### 待审核\n\n来自 x\n\n| 原文 | 译文 |\n| --- | --- |\n| a | 甲 |\n");
		const twice = appendPendingTerms(once, [t("b", "乙")], "x").text;
		expect(twice).toContain("| a | 甲 |\n| b | 乙 |");
		expect(parseGlossaryNote(twice).terms).toEqual([]);
	});

	it("没有新术语时原样返回；保留 CRLF", () => {
		const note = "| 原文 | 译文 |\r\n| --- | --- |\r\n| a | 甲 |\r\n";
		expect(appendPendingTerms(note, [t("A", "x")], "x")).toEqual({ text: note, added: 0 });
		expect(appendPendingTerms(note, [t("b", "乙")], "x").text).toContain("\r\n## 待审核\r\n");
	});
});
