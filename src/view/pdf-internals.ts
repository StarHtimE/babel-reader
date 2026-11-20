/**
 * Obsidian PDF 视图的非公开 API，全部集中在这里。
 * 每处访问都带类型守卫，读不到时回退（页号回退到第 1 页）。
 *
 * 对象路径参考 PDF++ 的类型声明（RyotaUshio/obsidian-pdf-plus, src/typings.d.ts）：
 *   PDFView.viewer: PDFViewerComponent
 *   PDFViewerComponent.child: PDFViewerChild | null
 *   PDFViewerChild.pdfViewer: ObsidianViewer
 *   ObsidianViewer.pdfViewer: PDFViewer | null        （pdf.js 的 PDFViewer）
 *   PDFViewer.currentPageNumber: number               （1 起）
 *   PDFViewer.pagesCount: number
 *   PDFView.getState(): { file: string; page: number; ... }
 */
import { FileView, type TFile, type View, type WorkspaceLeaf } from "obsidian";
import { normalizePage, pageSubpath } from "../core/page";

export const PDF_VIEW_TYPE = "pdf";

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function readPath(root: unknown, keys: readonly string[]): unknown {
	let cur: unknown = root;
	for (const k of keys) {
		if (!isObject(cur)) return undefined;
		cur = cur[k];
	}
	return cur;
}

export function isPdfView(view: View | null | undefined): view is FileView {
	return view instanceof FileView && view.getViewType() === PDF_VIEW_TYPE;
}

/** pdf.js 的 PDFViewer；视图还没加载完时返回 undefined */
function getPdfJsViewer(view: FileView): Record<string, unknown> | undefined {
	const viewer = readPath(view, ["viewer", "child", "pdfViewer", "pdfViewer"]);
	return isObject(viewer) ? viewer : undefined;
}

function readPageFromState(view: FileView): number | undefined {
	try {
		const state: unknown = view.getState();
		const page = readPath(state, ["page"]);
		return typeof page === "number" ? page : undefined;
	} catch {
		return undefined;
	}
}

/** 当前页号（1 起）；内部对象读不到时依次回退到 getState().page、第 1 页 */
export function getCurrentPage(view: FileView): number {
	const pdfjs = getPdfJsViewer(view);
	const current = pdfjs?.currentPageNumber;
	if (typeof current === "number" && current >= 1) {
		const count = pdfjs?.pagesCount;
		return normalizePage(current, typeof count === "number" && count > 0 ? count : undefined);
	}
	return normalizePage(readPageFromState(view));
}

/** 在给定 leaf 里打开 PDF 并定位到第 page 页（公开 API：eState.subpath） */
export async function openPdfAtPage(leaf: WorkspaceLeaf, file: TFile, page: number): Promise<void> {
	await leaf.openFile(file, { active: true, eState: { subpath: pageSubpath(page) } });
}
