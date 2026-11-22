import { Modal, Setting, type App, type ButtonComponent, type TFile } from "obsidian";
import { errorMessage } from "../core/errors";
import { describePageRanges, parsePageRanges } from "../core/page";

export interface PagesModalOptions {
	file: TFile;
	/** 当前页号（从 PDF 视图打开时才有） */
	currentPage?: number;
	/** 总页数（读得到时才有） */
	pageCount?: number;
	/** 已有译文时，上次翻译的页码范围（null 为全部页） */
	previousPages?: string | null;
}

/** 「翻译指定页」：输入页码范围，当场校验 */
export class PagesModal extends Modal {
	private value = "";
	private parsed: string | null = null;
	private messageEl: HTMLElement | null = null;
	private startButton: ButtonComponent | null = null;
	private submitted = false;

	constructor(
		app: App,
		private readonly opts: PagesModalOptions,
		private readonly onSubmit: (pages: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { file, currentPage, pageCount, previousPages } = this.opts;
		this.setTitle("翻译指定页");
		const el = this.contentEl;
		el.createEl("p", { text: pageCount ? `「${file.basename}」，共 ${pageCount} 页。` : `「${file.basename}」` });

		let input: HTMLInputElement | null = null;
		new Setting(el)
			.setName("页码")
			.setDesc("例如 1-5, 8；「10-」表示第 10 页到最后一页。没选中的页保留原文，页码不变")
			.addText((t) => {
				input = t.inputEl;
				t.setPlaceholder(currentPage ? `例如 ${currentPage}-${currentPage + 2}` : "例如 1-5").onChange((v) => {
					this.value = v;
					this.validate();
				});
			});

		if (currentPage) {
			new Setting(el)
				.setName("快捷选择")
				.addButton((b) => b.setButtonText(`当前页（${currentPage}）`).onClick(() => this.fill(input, `${currentPage}`)))
				.addButton((b) => b.setButtonText(`从当前页到最后`).onClick(() => this.fill(input, `${currentPage}-`)));
		}

		this.messageEl = el.createEl("p", { cls: "babel-reader-pages-message" });
		if (previousPages !== undefined) {
			el.createEl("p", {
				cls: "setting-item-description",
				text: `已有译文（${describePageRanges(previousPages)}），这次的结果会替换它，不会与上次合并。`,
			});
		}

		new Setting(el)
			.addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
			.addButton((b) => {
				this.startButton = b;
				b.setButtonText("开始翻译")
					.setCta()
					.onClick(() => this.submit());
			});

		this.scope.register([], "Enter", (evt) => {
			if (evt.isComposing) return;
			evt.preventDefault();
			this.submit();
		});
		this.validate();
		window.setTimeout(() => input?.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private fill(input: HTMLInputElement | null, value: string): void {
		this.value = value;
		if (input) input.value = value;
		this.validate();
	}

	private validate(): void {
		let message: string;
		let warn = false;
		try {
			this.parsed = parsePageRanges(this.value, this.opts.pageCount);
			message = this.parsed === null ? "请输入页码" : `将翻译：${describePageRanges(this.parsed)}`;
		} catch (err) {
			this.parsed = null;
			message = errorMessage(err);
			warn = true;
		}
		this.messageEl?.setText(message);
		this.messageEl?.toggleClass("babel-reader-rename-warning", warn);
		this.startButton?.setDisabled(this.parsed === null);
	}

	private submit(): void {
		if (this.submitted || this.parsed === null) return;
		this.submitted = true;
		const pages = this.parsed;
		this.close();
		this.onSubmit(pages);
	}
}
