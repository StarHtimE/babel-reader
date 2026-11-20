import { describe, expect, it } from "vitest";
import {
	isInsideDir,
	isShortId,
	joinVaultPath,
	outputFileName,
	parentPath,
	pdfBasename,
	sanitizeFileName,
	shortIdFromBytes,
	translationDirName,
} from "../src/core/naming";

describe("naming", () => {
	it("短 ID 为 6 位 base36", () => {
		const id = shortIdFromBytes(new Uint8Array([0, 1, 35, 36, 255, 100]));
		expect(id).toBe("01z03s");
		expect(isShortId(id)).toBe(true);
		expect(isShortId("ABCDEF")).toBe(false);
		expect(isShortId("abc")).toBe(false);
		expect(() => shortIdFromBytes(new Uint8Array(3))).toThrow();
	});

	it("取 PDF 的 basename，保留中文和空格", () => {
		expect(pdfBasename("Papers/合成孔径 雷达.pdf")).toBe("合成孔径 雷达");
		expect(pdfBasename("a.PDF")).toBe("a");
		expect(pdfBasename("x.y.pdf")).toBe("x.y");
	});

	it("清理文件名里的非法字符", () => {
		expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n')).toBe("a_b_c_d_e_f_g_h_i_j_k_l_m_n");
		expect(sanitizeFileName("name. ")).toBe("name");
		expect(sanitizeFileName("   ")).toBe("untitled");
	});

	it("按约定生成目录名和输出文件名", () => {
		expect(translationDirName("Speckle Filter", "a1b2c3")).toBe("Speckle Filter-a1b2c3");
		expect(outputFileName("Speckle Filter", "zh", "mono")).toBe("Speckle Filter.zh.mono.pdf");
		expect(outputFileName("论文", "zh-TW", "dual")).toBe("论文.zh-TW.dual.pdf");
	});

	it("拼接仓库路径", () => {
		expect(joinVaultPath("_translations/", "/x-abc123", "x.pdf")).toBe("_translations/x-abc123/x.pdf");
		expect(joinVaultPath("a\\b", ".", "c")).toBe("a/b/c");
		expect(joinVaultPath("", "manifest.json")).toBe("manifest.json");
	});

	it("parentPath / isInsideDir", () => {
		expect(parentPath("a/b/c.json")).toBe("a/b");
		expect(parentPath("c.json")).toBe("");
		expect(isInsideDir("_translations/x/m.json", "_translations")).toBe(true);
		expect(isInsideDir("_translations2/x", "_translations")).toBe(false);
		expect(isInsideDir("anything", "")).toBe(true);
	});
});
