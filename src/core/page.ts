/**
 * 页码映射。原文、mono、dual 第 N 页恒对应同一内容，
 * 所以切换模式只需要把当前页号原样带到另一个文件。
 */

/** 任意值 → 合法页号（正整数），不合法时回退到第 1 页 */
export function normalizePage(value: unknown, pageCount?: number): number {
	let page = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 1;
	if (page < 1) page = 1;
	if (pageCount !== undefined && Number.isFinite(pageCount) && pageCount >= 1 && page > pageCount) {
		page = Math.floor(pageCount);
	}
	return page;
}

/** 生成 Obsidian 打开 PDF 时识别的子路径，如 "#page=3" */
export function pageSubpath(page: number): string {
	return `#page=${normalizePage(page)}`;
}

/** 从 "#page=3" 这样的子路径里读页号；读不到返回 null */
export function parsePageSubpath(subpath: string): number | null {
	const m = /(?:^#|&)page=(\d+)/.exec(subpath);
	if (!m?.[1]) return null;
	const n = Number.parseInt(m[1], 10);
	return n >= 1 ? n : null;
}

// ---- 指定页翻译的页码范围 ---------------------------------------------------

/**
 * 解析用户输入的页码范围，返回服务端（pdf2zh_next）接受的格式；空白返回 null（翻译全部）。
 * 支持 "1-3, 5"、"10-"（到最后一页）、"-3"（从第 1 页起）；页码从 1 开始。
 * 全角逗号、各种横线、波浪线都当作分隔符。pageCount 已知时检查是否超出总页数。
 */
export function parsePageRanges(text: string, pageCount?: number): string | null {
	const cleaned = text
		.normalize("NFKC")
		.replace(/[、;；]/g, ",")
		.replace(/[–—~〜－]/g, "-")
		.replace(/\s+/g, "");
	if (cleaned === "") return null;
	const known = pageCount !== undefined && Number.isInteger(pageCount) && pageCount >= 1;
	const parts: string[] = [];
	for (const part of cleaned.split(",")) {
		if (part === "") continue;
		const m = /^(\d*)(-?)(\d*)$/.exec(part);
		if (!m || (m[1] === "" && m[3] === "") || (m[2] === "" && m[3] !== "")) {
			throw new PageRangeError(`「${part}」不是有效的页码，应形如 1-3、5 或 10-`);
		}
		const start = m[1] === "" ? null : Number.parseInt(m[1] ?? "", 10);
		const end = m[3] === "" ? null : Number.parseInt(m[3] ?? "", 10);
		if (start === 0 || end === 0) throw new PageRangeError("页码从 1 开始");
		if (start !== null && end !== null && start > end) {
			throw new PageRangeError(`「${part}」的起始页大于结束页`);
		}
		if (known && start !== null && start > pageCount) {
			throw new PageRangeError(`第 ${start} 页超出了总页数（共 ${pageCount} 页）`);
		}
		if (m[2] === "") parts.push(String(start));
		else parts.push(`${start ?? ""}-${end ?? ""}`);
	}
	if (parts.length === 0) return null;
	return parts.join(",");
}

export class PageRangeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PageRangeError";
	}
}

/** 给用户看的说明："1-3,5,10-" → "第 1-3、5、10-末 页" */
export function describePageRanges(pages: string | null): string {
	if (pages === null || pages.trim() === "") return "全部页";
	const items = pages.split(",").map((p) => {
		if (p.endsWith("-")) return `${p}末`;
		if (p.startsWith("-")) return `1${p}`;
		return p;
	});
	return `第 ${items.join("、")} 页`;
}
