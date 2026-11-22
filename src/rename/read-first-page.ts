import { loadPdfJs } from "obsidian";
import { metadataTitleFromPdfJs, pageTextFromPdfJs } from "../core/pdfjs-text";
import type { PageText } from "../core/title";
import { isRecord } from "../core/validate";

export interface FirstPageInfo {
	/** 首页文字；没有文字层或读取失败时为 null */
	page: PageText | null;
	/** PDF 元数据里的标题（已过滤模板残留） */
	metadataTitle: string | null;
}

/*
 * 用 Obsidian 自带的 pdf.js（公开 API loadPdfJs）读首页文字和元数据。
 * loadPdfJs 的返回类型是 any：这里只用到下面几个方法，逐一做类型守卫。
 * 参考 pdf.js API：getDocument({ data }).promise → PDFDocumentProxy；
 * doc.getMetadata() / doc.getPage(1) / page.getTextContent() / page.view / doc.destroy()。
 */

function method(obj: unknown, name: string): ((...args: unknown[]) => unknown) | null {
	if (!isRecord(obj)) return null;
	const fn = obj[name];
	return typeof fn === "function" ? (fn as (...args: unknown[]) => unknown).bind(obj) : null;
}

async function call(obj: unknown, name: string, ...args: unknown[]): Promise<unknown> {
	const fn = method(obj, name);
	if (!fn) throw new Error(`pdf.js 缺少 ${name}()`);
	return await fn(...args);
}

export async function readFirstPage(data: ArrayBuffer): Promise<FirstPageInfo> {
	const pdfjs: unknown = await loadPdfJs();
	const getDocument = method(pdfjs, "getDocument");
	if (!getDocument) throw new Error("无法使用 Obsidian 内置的 PDF 解析器");
	// pdf.js 会把数据转交给 worker：传一份副本，不影响调用方的缓冲区
	const task = getDocument({ data: new Uint8Array(data.slice(0)) });
	const docPromise: unknown = isRecord(task) ? task.promise : null;
	if (!(docPromise instanceof Promise)) throw new Error("无法使用 Obsidian 内置的 PDF 解析器");
	const doc: unknown = await docPromise;
	try {
		let metadataTitle: string | null = null;
		try {
			metadataTitle = metadataTitleFromPdfJs(await call(doc, "getMetadata"));
		} catch {
			// 元数据损坏不影响读首页文字
		}
		let page: PageText | null = null;
		try {
			const first = await call(doc, "getPage", 1);
			const content = await call(first, "getTextContent");
			page = pageTextFromPdfJs(isRecord(first) ? first.view : null, isRecord(content) ? content.items : null);
			method(first, "cleanup")?.();
		} catch (err) {
			console.warn("[babel-reader] 读取 PDF 首页文字失败", err);
		}
		return { page, metadataTitle };
	} finally {
		await method(doc, "destroy")?.();
	}
}
