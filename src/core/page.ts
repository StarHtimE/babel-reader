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
