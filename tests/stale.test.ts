import { describe, expect, it } from "vitest";
import { freshness, HashCache } from "../src/core/stale";

describe("HashCache", () => {
	it("修改时间或大小变了就失效", () => {
		const c = new HashCache();
		c.set("a.pdf", { mtime: 1, size: 10 }, "h1");
		expect(c.get("a.pdf", { mtime: 1, size: 10 })).toBe("h1");
		expect(c.get("a.pdf", { mtime: 2, size: 10 })).toBeUndefined();
		expect(c.get("a.pdf", { mtime: 1, size: 11 })).toBeUndefined();
		c.delete("a.pdf");
		expect(c.get("a.pdf", { mtime: 1, size: 10 })).toBeUndefined();
	});

	it("改名时缓存跟着搬", () => {
		const c = new HashCache();
		const s = { mtime: 1, size: 1 };
		c.set("Papers/x/a.pdf", s, "h");
		c.set("Papers2/b.pdf", s, "h2");
		c.rename("Papers", "Refs");
		expect(c.get("Refs/x/a.pdf", s)).toBe("h");
		expect(c.get("Papers/x/a.pdf", s)).toBeUndefined();
		expect(c.get("Papers2/b.pdf", s)).toBe("h2");
	});
});

describe("freshness", () => {
	it("比较哈希", () => {
		expect(freshness("h", "h")).toBe("fresh");
		expect(freshness("h", "x")).toBe("stale");
		expect(freshness("h", undefined)).toBe("unknown");
	});
});
