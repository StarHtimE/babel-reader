import { Notice, type App } from "obsidian";
import { errorMessage } from "../core/errors";
import { pdfBasename } from "../core/naming";
import type { TranslationEntry } from "../core/translation-index";
import type { TranslationStore } from "../store/translation-store";
import { confirmDialog } from "./confirm-modal";

/** 同一次操作（例如删除整个文件夹）会连续触发多个删除事件：合并成一次询问 */
const DEBOUNCE_MS = 800;

/**
 * 原文被删除后，询问是否把它的译文也移到回收站。
 * 默认保留：从回收站恢复原文后译文会自动重新关联。
 */
export class OrphanPrompt {
	private pending = new Map<string, TranslationEntry>();
	private timer: number | null = null;
	private asking = false;

	constructor(
		private readonly app: App,
		private readonly store: TranslationStore,
	) {}

	add(entries: TranslationEntry[]): void {
		for (const e of entries) this.pending.set(e.manifestPath, e);
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, DEBOUNCE_MS);
	}

	dispose(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.pending.clear();
	}

	private async flush(): Promise<void> {
		if (this.asking) return; // 等当前对话框结束后再处理新的
		// 期间原文可能已被恢复，或译文本身也被删了
		const entries = [...this.pending.values()].filter(
			(e) => this.store.index.get(e.manifestPath) !== undefined && !this.store.sourceExists(e),
		);
		this.pending.clear();
		if (entries.length === 0) return;

		const sources = [...new Set(entries.map((e) => e.manifest.source.path))];
		const first = sources[0] ?? "";
		const what = sources.length === 1 ? `原文「${pdfBasename(first)}」` : `${sources.length} 篇原文`;
		this.asking = true;
		let ok: boolean;
		try {
			ok = await confirmDialog(this.app, {
				title: "原文已删除",
				message: `${what}已删除，是否把对应的译文（${entries.length} 组）也删除？译文会按 Obsidian 的删除设置移到回收站。`,
				confirmText: "删除译文",
				cancelText: "保留译文",
			});
		} finally {
			this.asking = false;
		}
		if (ok) {
			try {
				const n = await this.store.trashEntries(entries);
				new Notice(`已删除 ${n} 组译文`);
			} catch (err) {
				console.error("[babel-reader] 删除译文失败", err);
				new Notice(`删除译文失败：${errorMessage(err)}`);
			}
		}
		if (this.pending.size > 0) void this.flush();
	}
}
