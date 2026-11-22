import { Notice, TFile, TFolder, type App, type Menu, type TAbstractFile } from "obsidian";
import { langOutOf, type BabelReaderSettings } from "../core/settings-model";
import type { TitleRenamer } from "../rename/title-renamer";
import type { TranslationStore } from "../store/translation-store";
import { BatchTranslateModal } from "../view/batch-translate-modal";
import type { TranslationJobs } from "./translation-jobs";

/** 文件列表右键菜单里的翻译 / 重命名：单个 PDF、文件夹、多选 */
export class BatchActions {
	constructor(
		private readonly app: App,
		private readonly store: TranslationStore,
		private readonly jobs: TranslationJobs,
		private readonly renamer: TitleRenamer,
		private readonly getSettings: () => BabelReaderSettings,
	) {}

	/** 往右键菜单里加菜单项；targets 里没有可处理的 PDF 时什么都不加 */
	addMenuItems(menu: Menu, targets: readonly TAbstractFile[]): void {
		const pdfs = this.store.collectSourcePdfs(targets);
		if (pdfs.length === 0) return;
		const only = targets.length === 1 ? targets[0] : undefined;
		let translateTitle: string;
		let renameTitle: string;
		if (only instanceof TFile) {
			translateTitle = "翻译此 PDF";
			renameTitle = "按论文标题重命名";
		} else if (only instanceof TFolder) {
			translateTitle = `翻译文件夹内的 PDF（${pdfs.length} 篇）`;
			renameTitle = `按论文标题重命名文件夹内的 PDF（${pdfs.length} 篇）`;
		} else {
			translateTitle = `翻译选中的 PDF（${pdfs.length} 篇）`;
			renameTitle = `按论文标题重命名选中的 PDF（${pdfs.length} 篇）`;
		}
		menu.addItem((item) =>
			item
				.setTitle(translateTitle)
				.setIcon("languages")
				.onClick(() => this.translate(targets)),
		);
		menu.addItem((item) =>
			item
				.setTitle(renameTitle)
				.setIcon("pencil")
				.onClick(() => void this.renamer.runBatch(this.store.collectSourcePdfs(targets))),
		);
	}

	/** 翻译单个 PDF 时直接加入队列；文件夹或多选时先弹窗确认 */
	translate(targets: readonly TAbstractFile[]): void {
		const pdfs = this.store.collectSourcePdfs(targets);
		const only = targets.length === 1 ? targets[0] : undefined;
		if (only instanceof TFile && pdfs[0] === only) {
			this.jobs.translate(only);
			return;
		}
		if (pdfs.length === 0) {
			new Notice("没有找到可以翻译的 PDF（译文文件不会再翻译）");
			return;
		}
		const langOut = langOutOf(this.getSettings());
		const plan = { fresh: [] as TFile[], translated: [] as TFile[], queued: [] as TFile[], langOut };
		for (const f of pdfs) {
			if (this.jobs.isQueued(f)) plan.queued.push(f);
			else if (this.store.hasTranslation(f.path, langOut)) plan.translated.push(f);
			else plan.fresh.push(f);
		}
		new BatchTranslateModal(this.app, plan, (files) => {
			const n = this.jobs.enqueue(files);
			new Notice(`已加入翻译队列：${n} 篇`);
		}).open();
	}
}
