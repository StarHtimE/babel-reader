import { describe, expect, it } from "vitest";
import {
	cleanTitle,
	suggestTitle,
	titleFromMetadata,
	titleFromPage,
	type PageText,
	type TextRun,
} from "../src/core/title";

/** 简化：每个字符宽 0.5 倍字号 */
function run(text: string, x: number, y: number, size: number, patch: Partial<TextRun> = {}): TextRun {
	return { text, x, y, size, width: text.length * size * 0.5, rotated: false, ...patch };
}

function page(runs: TextRun[]): PageText {
	return { view: [0, 0, 612, 792], runs };
}

const BODY = [
	run("Abstract—We propose a new method for speckle suppression.", 50, 500, 9),
	run("1. Introduction", 50, 400, 10),
];

describe("titleFromPage", () => {
	it("取上方字号最大的一段，跨行拼接", () => {
		const p = page([
			run("IEEE TRANSACTIONS ON GEOSCIENCE AND REMOTE SENSING, VOL. 60, 2022", 50, 760, 8),
			run("Deep Learning for SAR Image", 80, 700, 24),
			run("Despeckling: A Review", 120, 672, 24),
			run("Alice Zhang, Bob Li", 200, 630, 11),
			...BODY,
		]);
		expect(titleFromPage(p)).toBe("Deep Learning for SAR Image Despeckling: A Review");
	});

	it("跳过 arXiv 竖排水印和脚注上标", () => {
		const p = page([
			run("arXiv:2108.13342v2 [eess.IV] 1 Sep 2021", 20, 300, 20, { rotated: true }),
			run("Attention", 100, 700, 17),
			run("Is", 190, 700, 17),
			run("All You Need", 210, 700, 17),
			run("∗", 330, 706, 7),
			run("Ashish Vaswani", 100, 650, 10),
			...BODY,
		]);
		expect(titleFromPage(p)).toBe("Attention Is All You Need");
	});

	it("行尾连字符：小写续行时去掉连字符", () => {
		const p = page([
			run("A Satellite-Born Server Design with Mas-", 60, 700, 20),
			run("sive Tiny Chips Towards In-Space Computing", 60, 676, 20),
			...BODY,
		]);
		expect(titleFromPage(p)).toBe("A Satellite-Born Server Design with Massive Tiny Chips Towards In-Space Computing");
	});

	it("最大的一行是文章类型标签或 DOI 时跳过", () => {
		const p = page([
			run("ORIGINAL RESEARCH", 50, 760, 30),
			run("doi: 10.3389/fspas.2026.1832412", 50, 740, 26),
			run("Solar wind effects on the ionosphere", 50, 700, 22),
			...BODY,
		]);
		expect(titleFromPage(p)).toBe("Solar wind effects on the ionosphere");
	});

	it("中文标题不插空格", () => {
		const p = page([
			run("基于深度学习的", 100, 700, 22, { width: 7 * 22 }),
			run("合成孔径雷达图像去噪", 100 + 7 * 22, 700, 22, { width: 10 * 22 }),
			run("张三 李四", 200, 660, 12),
			...BODY,
		]);
		expect(titleFromPage(p)).toBe("基于深度学习的合成孔径雷达图像去噪");
	});

	it("不收进行距过大的相同字号文字", () => {
		const p = page([
			run("Short Title Here", 100, 720, 20),
			run("Another Big Line Far Below", 100, 600, 20),
			...BODY,
		]);
		expect(titleFromPage(p)).toBe("Short Title Here");
	});

	it("页面下方的大字、空白页都不算", () => {
		expect(titleFromPage(page([run("Big Footer Words", 100, 100, 40)]))).toBeNull();
		expect(titleFromPage(page([]))).toBeNull();
		expect(titleFromPage({ view: [0, 0, 0, 0], runs: [] })).toBeNull();
	});
});

describe("titleFromMetadata", () => {
	it("过滤模板残留和文件名", () => {
		expect(titleFromMetadata("Microsoft Word - draft_v3.docx")).toBeNull();
		expect(titleFromMetadata("Paper Title (use style: paper title)")).toBeNull();
		expect(titleFromMetadata("untitled")).toBeNull();
		expect(titleFromMetadata("TGRS-2021-01234")).toBeNull();
		expect(titleFromMetadata("main.tex")).toBeNull();
		expect(titleFromMetadata("")).toBeNull();
		expect(titleFromMetadata(null)).toBeNull();
		expect(titleFromMetadata("  Attention Is All You Need  ")).toBe("Attention Is All You Need");
		expect(titleFromMetadata("合成孔径雷达成像")).toBe("合成孔径雷达成像");
	});
});

describe("cleanTitle", () => {
	it("去掉首尾的脚注标记，合并连字", () => {
		expect(cleanTitle("  Eﬃcient   Models∗† ")).toBe("Efficient Models");
	});
});

describe("suggestTitle", () => {
	const textPage = page([run("SAR IMAGE DESPECKLING NETWORKS", 80, 700, 20), ...BODY]);

	it("首页文字优先，元数据作为另一个候选", () => {
		const s = suggestTitle(textPage, "An Earlier Working Version");
		expect(s?.primary).toEqual({ title: "SAR IMAGE DESPECKLING NETWORKS", source: "text" });
		expect(s?.alternatives).toEqual([{ title: "An Earlier Working Version", source: "metadata" }]);
	});

	it("两者一致而首页是全大写时，用元数据的大小写", () => {
		const s = suggestTitle(textPage, "SAR Image Despeckling Networks");
		expect(s?.primary).toEqual({ title: "SAR Image Despeckling Networks", source: "metadata" });
		expect(s?.alternatives).toEqual([]);
	});

	it("只有一方可用时用那一方；都没有时返回 null", () => {
		expect(suggestTitle(null, "A Useful Metadata Title")?.primary.source).toBe("metadata");
		expect(suggestTitle(textPage, "untitled")?.primary.source).toBe("text");
		expect(suggestTitle(page([]), null)).toBeNull();
	});
});

describe("真实 PDF 里见过的情况", () => {
	it("XMP 标题重复两遍时取一遍", () => {
		const t = "DNNFusion: Accelerating Deep Neural Networks";
		expect(titleFromMetadata(t + t)).toBe(t);
	});

	it("Elsevier 页眉里的期刊名字号比标题大时跳过", () => {
		const p = page([
			run("Contents lists available at ScienceDirect", 227, 725, 8),
			run("ISPRS Journal of Photogrammetry and Remote Sensing", 132, 697, 13.9),
			run("journal homepage: www.elsevier.com/locate/isprsjprs", 196, 670, 8),
			run("A differentiable method for novel view SAR image generation via 3D", 38, 617, 13.4),
			run("Gaussian Splatting", 38, 600, 13.4),
			run("Zinan Liu", 38, 580, 10.6),
			...BODY,
		]);
		expect(titleFromPage(p)).toBe("A differentiable method for novel view SAR image generation via 3D Gaussian Splatting");
		// 期刊名不含 Journal 字样时，靠上下两行的页眉认出来
		const q = page([
			run("Contents lists available at ScienceDirect", 227, 725, 8),
			run("Remote Sensing of Environment", 132, 697, 16),
			run("journal homepage: www.elsevier.com/locate/rse", 196, 670, 8),
			run("Mapping Forest Height from Space", 38, 617, 14),
			...BODY,
		]);
		expect(titleFromPage(q)).toBe("Mapping Forest Height from Space");
	});

	it("small caps 标题：首字母大字号、其余小一号大写，拼成正常大小写", () => {
		// Spikformer（ICLR 2023 投稿版）首页，字号按 pdf.js 可能给出的略有出入的值
		const r = (text: string, x0: number, x1: number, y: number, size: number) =>
			run(text, x0, y, size, { width: x1 - x0 });
		const p = page([
			r("FOR REVIEW", 108, 168.6, 756.6, 10),
			r("S", 108.4, 118, 698.4, 17.22),
			r("PIKFORMER", 118.9, 204.5, 698.4, 13.77),
			r(":", 205.3, 210.1, 698.4, 17.22),
			r("W", 226.3, 242.6, 698.4, 17.22),
			r("HEN", 243.4, 273.4, 698.4, 13.77),
			r("S", 283.6, 293.1, 698.4, 17.22),
			r("PIKING", 294, 344.9, 698.4, 13.77),
			r("N", 355.1, 367.5, 698.4, 17.22),
			r("EURAL", 368.4, 417.7, 698.4, 13.77),
			r("N", 427.8, 440.2, 698.4, 17.22),
			r("ETWORK", 441.1, 504.1, 698.4, 13.77),
			r("M", 108.4, 123.7, 678.5, 17.22),
			r("EETS", 124.6, 160, 678.5, 13.77),
			r(" T", 160, 175.7, 678.5, 17.22),
			r("RANSFORMER", 176.6, 277.6, 678.5, 13.77),
			r("1,2", 116.5, 126.8, 651, 7),
			r("Zhaokun Zhou", 127.3, 191.2, 647.4, 10),
			...BODY,
		]);
		expect(titleFromPage(p)).toBe("Spikformer: When Spiking Neural Network Meets Transformer");
	});

	it("首页文字与元数据一致时来源记为首页文字", () => {
		const p = page([run("Same Title In Both Places", 80, 700, 20), ...BODY]);
		expect(suggestTitle(p, "Same Title In Both Places")).toEqual({
			primary: { title: "Same Title In Both Places", source: "text" },
			alternatives: [],
		});
	});
});
