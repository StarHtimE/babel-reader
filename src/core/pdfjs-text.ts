import { titleFromMetadata, type PageText, type TextRun } from "./title";
import { isRecord } from "./validate";

/**
 * 把 pdf.js `page.getTextContent().items` 转成 TextRun（运行时校验，不信任外部数据）。
 * pdf.js 文本项：{ str, transform: [a, b, c, d, e, f], width, height, fontName, hasEOL }；
 * 标记内容项（没有 str）跳过。
 */
export function runsFromPdfJsItems(items: unknown): TextRun[] {
	if (!Array.isArray(items)) return [];
	const runs: TextRun[] = [];
	for (const item of items) {
		if (!isRecord(item) || typeof item.str !== "string" || item.str.trim() === "") continue;
		const t = item.transform;
		if (!Array.isArray(t) || t.length < 6 || !t.every((v) => typeof v === "number" && Number.isFinite(v))) {
			continue;
		}
		const [a, b, c, d, e, f] = t as number[];
		if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
		if (e === undefined || f === undefined) continue;
		const size = Math.hypot(c, d);
		if (!(size > 0)) continue;
		const width = typeof item.width === "number" && Number.isFinite(item.width) ? Math.abs(item.width) : 0;
		runs.push({
			text: item.str,
			x: e,
			y: f,
			size,
			width,
			// 正常的横排文字 a > 0 且 b ≈ 0；竖排水印、旋转文字都不满足
			rotated: !(a > 0) || Math.abs(b) > 0.05 * Math.abs(a),
		});
	}
	return runs;
}

/** pdf.js `page.view`：[x0, y0, x1, y1] */
export function pageTextFromPdfJs(view: unknown, items: unknown): PageText | null {
	if (!Array.isArray(view) || view.length !== 4 || !view.every((v) => typeof v === "number")) return null;
	const [x0, y0, x1, y1] = view;
	if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return null;
	return {
		view: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)],
		runs: runsFromPdfJsItems(items),
	};
}

/**
 * pdf.js `doc.getMetadata()` 的结果里取标题：XMP 的 dc:title 和 Info 字典的 /Title 中，
 * 第一个不是模板残留的那个；都不可用时返回 null。
 */
export function metadataTitleFromPdfJs(meta: unknown): string | null {
	if (!isRecord(meta)) return null;
	const raw: unknown[] = [];
	const xmp = meta.metadata;
	if (isRecord(xmp) && typeof xmp.get === "function") {
		try {
			raw.push((xmp.get as (key: string) => unknown).call(xmp, "dc:title"));
		} catch {
			// XMP 解析失败：只看 Info 字典
		}
	}
	if (isRecord(meta.info)) raw.push(meta.info.Title);
	for (const v of raw) {
		if (typeof v === "string" && titleFromMetadata(v) !== null) return v;
	}
	return null;
}
