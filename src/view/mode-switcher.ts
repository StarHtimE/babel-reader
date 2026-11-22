import { Notice, type App, type FileView, type TFile } from "obsidian";
import type { TranslationEntry } from "../core/translation-index";
import { VIEW_MODES, type ViewMode } from "../core/types";
import type { TranslationStore } from "../store/translation-store";
import { getCurrentPage, isPdfView, openPdfAtPage, PDF_VIEW_TYPE } from "./pdf-internals";

const MODE_LABELS: Record<ViewMode, string> = {
	original: "原文",
	mono: "译文",
	dual: "对照",
};

const MODE_ICONS: Record<ViewMode, string> = {
	original: "file-text",
	mono: "languages",
	dual: "book-open",
};

interface HeaderState {
	key: string;
	els: HTMLElement[];
}

/**
 * PDF 视图头部的按钮：
 * - 原文：始终有「翻译」按钮（已有译文时为「重新翻译」），以及「按论文标题重命名」
 * - 有译文（原文或译文本身）：另有 原文 / 译文 / 对照 三态切换，切换时保持页码
 */
export class ModeSwitcher {
	private states = new Map<FileView, HeaderState>();

	constructor(
		private readonly app: App,
		private readonly store: TranslationStore,
		private readonly onTranslate: (file: TFile) => void,
		private readonly onRename: (file: TFile) => void,
	) {}

	/** 刷新所有 PDF 视图的头部按钮 */
	refreshAll(): void {
		const alive = new Set<FileView>();
		for (const leaf of this.app.workspace.getLeavesOfType(PDF_VIEW_TYPE)) {
			const view = leaf.view;
			if (!isPdfView(view)) continue;
			alive.add(view);
			this.refresh(view);
		}
		// 已关闭的视图：丢掉记录
		for (const view of [...this.states.keys()]) {
			if (!alive.has(view)) this.states.delete(view);
		}
	}

	/** 卸载插件时移除所有按钮 */
	detachAll(): void {
		for (const state of this.states.values()) {
			for (const el of state.els) el.remove();
		}
		this.states.clear();
	}

	/** 当前 PDF 视图切换到指定模式；返回是否可执行（供命令的 checkCallback 使用） */
	switchActive(mode: ViewMode, checking: boolean): boolean {
		// PDF 视图类不公开，没法用 getActiveViewOfType，改为看最近活动的 leaf
		const active = this.app.workspace.getMostRecentLeaf()?.view;
		if (!isPdfView(active) || !active.file) return false;
		const plan = this.planFor(active.file);
		if (!plan?.entry || plan.current === mode || !plan.modes.includes(mode)) return false;
		const entry = plan.entry;
		if (!checking) void this.switchTo(active, entry, mode);
		return true;
	}

	private refresh(view: FileView): void {
		const file = view.file;
		const plan = file ? this.planFor(file) : null;
		const key = plan?.key ?? "";
		const old = this.states.get(view);
		if (old?.key === key) return;
		if (old) for (const el of old.els) el.remove();

		const els: HTMLElement[] = [];
		if (file && plan) {
			// addAction 往前插入：先加的显示在最右。最终顺序为 原文 / 译文 / 对照 / 翻译 / 重命名
			if (plan.translatable) {
				const rename = view.addAction("pencil", "按论文标题重命名", () => this.onRename(file));
				rename.addClass("babel-reader-rename-button");
				els.push(rename);

				// 已有译文时「译文」按钮占用了 languages 图标，重新翻译改用刷新图标以免重复
				const [icon, title] = plan.entry
					? ["refresh-cw", "重新翻译当前 PDF"]
					: ["languages", "翻译当前 PDF"];
				const el = view.addAction(icon, title, () => this.onTranslate(file));
				el.addClass("babel-reader-translate-button");
				els.push(el);
			}
			const entry = plan.entry;
			if (entry) {
				for (const mode of [...plan.modes].reverse()) {
					const el = view.addAction(MODE_ICONS[mode], `切换到${MODE_LABELS[mode]}`, () => {
						void this.switchTo(view, entry, mode);
					});
					el.addClass("babel-reader-mode-button");
					if (mode === plan.current) el.addClass("is-active");
					els.push(el);
				}
			}
		}
		this.states.set(view, { key, els });
	}

	/** 决定某个 PDF 视图头部应显示哪些按钮 */
	private planFor(file: TFile): {
		key: string;
		/** 当前文件的角色 */
		current: ViewMode;
		/** 原文上始终可以（重新）翻译；译文文件本身不再翻译 */
		translatable: boolean;
		/** 有可切换的译文时才有值 */
		entry: TranslationEntry | null;
		modes: ViewMode[];
	} | null {
		if (file.extension.toLowerCase() !== "pdf") return null;
		const resolved = this.store.resolve(file.path);
		const current: ViewMode = resolved?.mode ?? "original";
		let entry: TranslationEntry | null = null;
		let modes: ViewMode[] = [];
		if (resolved) {
			const available = VIEW_MODES.filter((m) => this.store.fileForMode(resolved.entry, m) !== null);
			// 至少要剩两个文件、且其中有译文，切换才有意义（译文被删光时退回「只有翻译按钮」）
			if (available.length >= 2 && available.some((m) => m !== "original")) {
				entry = resolved.entry;
				modes = available;
			}
		}
		const translatable = current === "original";
		const key = [
			file.path,
			current,
			modes.join(","),
			entry?.manifestPath ?? "",
			entry?.manifest.createdAt ?? "",
		].join("|");
		return { key, current, translatable, entry, modes };
	}

	private async switchTo(view: FileView, entry: TranslationEntry, mode: ViewMode): Promise<void> {
		const target = this.store.fileForMode(entry, mode);
		if (!target) {
			new Notice(`找不到${MODE_LABELS[mode]}文件，可能已被移动或删除`);
			return;
		}
		if (view.file?.path === target.path) return;
		const page = getCurrentPage(view);
		await openPdfAtPage(view.leaf, target, page);
	}
}
