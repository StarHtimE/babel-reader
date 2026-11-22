import { describe, expect, it } from "vitest";
import {
	describePageRanges,
	normalizePage,
	PageRangeError,
	pageSubpath,
	parsePageRanges,
	parsePageSubpath,
} from "../src/core/page";

describe("page", () => {
	it("不合法的页号回退到第 1 页", () => {
		expect(normalizePage(undefined)).toBe(1);
		expect(normalizePage("3")).toBe(1);
		expect(normalizePage(Number.NaN)).toBe(1);
		expect(normalizePage(0)).toBe(1);
		expect(normalizePage(-5)).toBe(1);
	});

	it("取整并限制在总页数之内", () => {
		expect(normalizePage(3.7)).toBe(3);
		expect(normalizePage(12, 10)).toBe(10);
		expect(normalizePage(5, 10)).toBe(5);
		expect(normalizePage(5, 0)).toBe(5);
	});

	it("子路径往返", () => {
		expect(pageSubpath(7)).toBe("#page=7");
		expect(pageSubpath(0)).toBe("#page=1");
		expect(parsePageSubpath("#page=7")).toBe(7);
		expect(parsePageSubpath("#zoom=2&page=4")).toBe(4);
		expect(parsePageSubpath("#selection=1")).toBeNull();
		expect(parsePageSubpath("#page=0")).toBeNull();
	});
});

describe("指定页翻译的页码范围", () => {
	it("规范成服务端接受的格式", () => {
		expect(parsePageRanges("")).toBeNull();
		expect(parsePageRanges("  ")).toBeNull();
		expect(parsePageRanges(" 1 - 3 , 5 ")).toBe("1-3,5");
		expect(parsePageRanges("10-")).toBe("10-");
		expect(parsePageRanges("-3")).toBe("-3");
		expect(parsePageRanges("1～3，5、8—9")).toBe("1-3,5,8-9");
		expect(parsePageRanges("1-3,,5,")).toBe("1-3,5");
	});

	it("格式或范围不对时给出说明", () => {
		expect(() => parsePageRanges("abc")).toThrow(PageRangeError);
		expect(() => parsePageRanges("1-2-3")).toThrow("不是有效的页码");
		expect(() => parsePageRanges("-")).toThrow("不是有效的页码");
		expect(() => parsePageRanges("0-3")).toThrow("从 1 开始");
		expect(() => parsePageRanges("5-3")).toThrow("起始页大于结束页");
		expect(() => parsePageRanges("20-", 12)).toThrow("共 12 页");
		expect(parsePageRanges("10-30", 12)).toBe("10-30");
	});

	it("给用户看的说明", () => {
		expect(describePageRanges(null)).toBe("全部页");
		expect(describePageRanges("1-3,5,10-")).toBe("第 1-3、5、10-末 页");
		expect(describePageRanges("-3")).toBe("第 1-3 页");
	});
});
