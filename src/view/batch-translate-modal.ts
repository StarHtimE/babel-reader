import { Modal, Setting, type App, type ButtonComponent, type TFile } from "obsidian";

export interface BatchTranslatePlan {
	/** 还没有译文的 */
	fresh: TFile[];
	/** 已有当前目标语言译文的 */
	translated: TFile[];
	/** 已在翻译队列里的（不会重复加入） */
	queued: TFile[];
	langOut: string;
}

const PREVIEW_LIMIT = 8;

/** 批量翻译前确认：显示要翻译几篇、跳过几篇；可以选择把已有译文的也重新翻译 */
export class BatchTranslateModal extends Modal {
	private includeTranslated = false;
	private startButton: ButtonComponent | null = null;
	private submitted = false;

	constructor(
		app: App,
		private readonly plan: BatchTranslatePlan,
		private readonly onSubmit: (files: TFile[]) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { fresh, translated, queued, langOut } = this.plan;
		const total = fresh.length + translated.length + queued.length;
		this.setTitle("批量翻译");
		const el = this.contentEl;
		el.createEl("p", { text: `找到 ${total} 篇 PDF，目标语言 ${langOut}：` });
		const ul = el.createEl("ul");
		ul.createEl("li", { text: `还没有译文：${fresh.length} 篇` });
		if (translated.length > 0) ul.createEl("li", { text: `已有译文：${translated.length} 篇（默认跳过）` });
		if (queued.length > 0) ul.createEl("li", { text: `已在翻译队列里：${queued.length} 篇（不会重复加入）` });

		if (fresh.length > 0) {
			const names = fresh.slice(0, PREVIEW_LIMIT).map((f) => f.basename);
			const more = fresh.length > PREVIEW_LIMIT ? ` 等 ${fresh.length} 篇` : "";
			el.createEl("p", { cls: "setting-item-description", text: `将翻译：${names.join("、")}${more}` });
		}

		if (translated.length > 0) {
			new Setting(el)
				.setName("已有译文的也重新翻译")
				.setDesc("会覆盖原来的译文。参数没变时会复用服务端的翻译缓存")
				.addToggle((t) =>
					t.setValue(false).onChange((v) => {
						this.includeTranslated = v;
						this.refresh();
					}),
				);
		}

		el.createEl("p", {
			cls: "setting-item-description",
			text: "翻译在后台逐篇进行，进度显示在状态栏；点状态栏可以查看队列、取消单篇或全部。",
		});

		new Setting(el)
			.addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
			.addButton((b) => {
				this.startButton = b;
				b.setCta().onClick(() => this.submit());
			});
		this.refresh();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private files(): TFile[] {
		return this.includeTranslated ? [...this.plan.fresh, ...this.plan.translated] : this.plan.fresh;
	}

	private refresh(): void {
		const n = this.files().length;
		this.startButton?.setButtonText(`开始翻译（${n} 篇）`).setDisabled(n === 0);
	}

	private submit(): void {
		const files = this.files();
		if (this.submitted || files.length === 0) return;
		this.submitted = true;
		this.close();
		this.onSubmit(files);
	}
}
