import { describe, expect, it } from "vitest";
import { normalizePage, pageSubpath, parsePageSubpath } from "../src/core/page";

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
