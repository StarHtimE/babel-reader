import { Modal, Notice, Setting, type App, type TAbstractFile, type TFile } from "obsidian";
import { errorMessage } from "../core/errors";
import { titleToFileName } from "../core/naming";
import { suggestTitle, type TitleCandidate, type TitleSuggestion } from "../core/title";
import type { TranslationStore } from "../store/translation-store";
import { BatchRenameModal, type BatchRenameRow } from "./batch-rename-modal";
import { readFirstPage } from "./read-first-page";
import { targetPathFor } from "./target-path";

export const SOURCE_LABELS: Record<TitleCandidate["source"], string> = {
	text: "首页文字",
	metadata: "PDF 元数据",
};

/**
 * 「按论文标题重命名」：识别标题 → 弹窗确认（可修改）→ 用 fileManager.renameFile 改名。
 * 只改文件名，不碰文件内容；译文目录由 TranslationStore 跟随原文改名。
 */
export class TitleRenamer {
	private busy = false;

	constructor(
		private readonly app: App,
		private readonly store: TranslationStore,
	) {}

	/** 可以按标题重命名的文件：PDF 原文（译文文件不行） */
	canRename(file: TAbstractFile | null): file is TFile {
		return file !== null && this.store.isSourcePdf(file);
	}

	/** 识别一篇 PDF 的标题；识别不出时返回 null */
	private async detect(file: TFile): Promise<TitleSuggestion | null> {
		const info = await readFirstPage(await this.app.vault.readBinary(file));
		return suggestTitle(info.page, info.metadataTitle);
	}

	async run(file: TFile): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const progress: { notice: Notice | null } = { notice: null };
		const timer = window.setTimeout(() => {
			progress.notice = new Notice("正在识别论文标题…", 0);
		}, 400);
		let suggestion: TitleSuggestion | null;
		try {
			suggestion = await this.detect(file);
		} catch (err) {
			console.error("[babel-reader] 识别标题失败", err);
			new Notice(`识别标题失败：${errorMessage(err)}`);
			return;
		} finally {
			window.clearTimeout(timer);
			progress.notice?.hide();
			this.busy = false;
		}
		if (!suggestion) {
			new Notice("没有识别出论文标题：可能是扫描版，或首页没有文字层");
			return;
		}
		const hasTranslations = this.store.index.entriesForSource(file.path).length > 0;
		new RenameModal(this.app, file, suggestion, hasTranslations, (path) => this.rename(file, path)).open();
	}

	/** 批量：逐篇识别标题，然后在一个列表弹窗里统一确认 */
	async runBatch(files: readonly TFile[]): Promise<void> {
		if (files.length === 0) {
			new Notice("没有找到可以重命名的 PDF");
			return;
		}
		if (files.length === 1 && files[0]) {
			await this.run(files[0]);
			return;
		}
		if (this.busy) return;
		this.busy = true;
		const notice = new Notice("", 0);
		const rows: BatchRenameRow[] = [];
		try {
			for (const [i, file] of files.entries()) {
				notice.setMessage(`正在识别论文标题 ${i + 1}/${files.length}…`);
				try {
					const suggestion = await this.detect(file);
					rows.push({ file, suggestion, error: suggestion ? null : "没有识别出标题（可能是扫描版）" });
				} catch (err) {
					console.warn(`[babel-reader] 识别标题失败：${file.path}`, err);
					rows.push({ file, suggestion: null, error: `识别失败：${errorMessage(err)}` });
				}
			}
		} finally {
			notice.hide();
			this.busy = false;
		}
		new BatchRenameModal(this.app, rows, (plans) => this.renameMany(plans)).open();
	}

	private async renameMany(plans: readonly { file: TFile; path: string }[]): Promise<void> {
		let ok = 0;
		const failed: string[] = [];
		for (const { file, path } of plans) {
			if (path === file.path) continue;
			try {
				await this.app.fileManager.renameFile(file, path);
				ok++;
			} catch (err) {
				console.error(`[babel-reader] 重命名失败：${file.path}`, err);
				failed.push(file.name);
			}
		}
		const tail = failed.length > 0 ? `，失败 ${failed.length} 篇：${failed.join("、")}` : "";
		new Notice(`已重命名 ${ok} 篇${tail}`, failed.length > 0 ? 10000 : 5000);
	}

	private async rename(file: TFile, path: string): Promise<void> {
		if (path === file.path) {
			new Notice("文件名没有变化");
			return;
		}
		try {
			await this.app.fileManager.renameFile(file, path);
			new Notice(`已重命名为「${file.name}」`);
		} catch (err) {
			console.error("[babel-reader] 重命名失败", err);
			new Notice(`重命名失败：${errorMessage(err)}`);
		}
	}
}

class RenameModal extends Modal {
	private value: string;
	private previewEl: HTMLElement | null = null;
	private submitted = false;

	constructor(
		app: App,
		private readonly file: TFile,
		private readonly suggestion: TitleSuggestion,
		private readonly hasTranslations: boolean,
		private readonly onSubmit: (path: string) => Promise<void>,
	) {
		super(app);
		this.value = titleToFileName(suggestion.primary.title) ?? file.basename;
	}

	onOpen(): void {
		this.setTitle("按论文标题重命名");
		const el = this.contentEl;
		el.addClass("babel-reader-rename");

		const primary = this.suggestion.primary;
		el.createEl("p", { text: `识别到的标题（来自${SOURCE_LABELS[primary.source]}）：` });
		el.createDiv({ cls: "babel-reader-rename-title", text: primary.title });

		let input: HTMLInputElement | null = null;
		for (const alt of this.suggestion.alternatives) {
			new Setting(el)
				.setName(`另一个候选（来自${SOURCE_LABELS[alt.source]}）`)
				.setDesc(alt.title)
				.addButton((b) =>
					b.setButtonText("使用").onClick(() => {
						this.value = titleToFileName(alt.title) ?? this.value;
						if (input) input.value = this.value;
						this.updatePreview();
					}),
				);
		}

		new Setting(el)
			.setName("新文件名")
			.setDesc("可以先修改再确认；冒号等不能用在文件名里的字符会自动替换")
			.addText((t) => {
				input = t.inputEl;
				t.inputEl.addClass("babel-reader-rename-input");
				t.setValue(this.value).onChange((v) => {
					this.value = v;
					this.updatePreview();
				});
			});

		this.previewEl = el.createEl("p", { cls: "babel-reader-rename-preview" });
		this.updatePreview();

		const notes = [`当前文件：${this.file.path}`];
		if (this.hasTranslations) notes.push("这篇 PDF 的译文目录和译文文件会一并改名。");
		notes.push("笔记里指向它的链接按 Obsidian「自动更新内部链接」设置处理。");
		for (const n of notes) el.createEl("p", { cls: "setting-item-description", text: n });

		new Setting(el)
			.addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("重命名")
					.setCta()
					.onClick(() => void this.submit()),
			);

		this.scope.register([], "Enter", (evt) => {
			if (evt.isComposing) return;
			evt.preventDefault();
			void this.submit();
		});
		window.setTimeout(() => {
			const i = input;
			i?.focus();
			i?.select();
		}, 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private target(): string | null {
		return targetPathFor(this.file, this.value);
	}

	private updatePreview(): void {
		if (!this.previewEl) return;
		const path = this.target();
		this.previewEl.toggleClass("mod-warning", path === null);
		this.previewEl.setText(path === null ? "文件名不能为空" : `将重命名为：${path}`);
	}

	private async submit(): Promise<void> {
		if (this.submitted) return;
		const path = this.target();
		if (path === null) return;
		this.submitted = true;
		this.close();
		await this.onSubmit(path);
	}
}
