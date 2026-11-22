import { Modal, Setting, type App } from "obsidian";
import { describePageRanges } from "../core/page";
import type { QueueItemState } from "../core/queue";
import type { TranslationItem, TranslationJobs } from "../jobs/translation-jobs";

const STATE_LABELS: Record<QueueItemState, string> = {
	waiting: "等待",
	running: "翻译中",
	done: "完成",
	error: "失败",
	cancelled: "已取消",
};

/** 翻译队列：每篇的状态、进度或失败原因；可以取消单篇或全部 */
export class QueueModal extends Modal {
	private unsubscribe: (() => void) | null = null;
	private listEl: HTMLElement | null = null;
	private footerEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly jobs: TranslationJobs,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("翻译队列");
		this.contentEl.addClass("babel-reader-queue");
		this.listEl = this.contentEl.createDiv({ cls: "babel-reader-queue-list" });
		this.footerEl = this.contentEl.createDiv();
		this.unsubscribe = this.jobs.onChange(() => this.render());
		this.render();
	}

	onClose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.contentEl.empty();
	}

	private render(): void {
		const list = this.listEl;
		const footer = this.footerEl;
		if (!list || !footer) return;
		list.empty();
		footer.empty();

		const items = this.jobs.items();
		if (items.length === 0) {
			list.createEl("p", { cls: "setting-item-description", text: "队列是空的。" });
		}
		for (const item of items) this.renderItem(list, item);

		const busy = this.jobs.isRunning;
		const s = new Setting(footer);
		if (busy) {
			s.addButton((b) => b.setButtonText("取消全部").onClick(() => this.jobs.cancelAll()));
		}
		s.addButton((b) => b.setButtonText("关闭").onClick(() => this.close()));
	}

	private renderItem(parent: HTMLElement, item: TranslationItem): void {
		const pages = this.jobs.pagesOf(item);
		const name = pages === null ? item.payload.basename : `${item.payload.basename}（${describePageRanges(pages)}）`;
		const row = new Setting(parent).setName(name);
		row.settingEl.addClass("babel-reader-queue-item", `is-${item.state}`);
		row.setDesc(describe(item));
		if (item.state === "waiting" || item.state === "running") {
			row.addExtraButton((b) =>
				b
					.setIcon("x")
					.setTooltip(item.state === "running" ? "取消这一篇（正在翻译）" : "从队列移除")
					.onClick(() => this.jobs.cancelItem(item)),
			);
		}
	}
}

function describe(item: TranslationItem): string {
	const label = STATE_LABELS[item.state];
	switch (item.state) {
		case "running":
			return item.detail;
		case "error":
			return item.error ? `${label}：${item.error}` : label;
		case "cancelled":
			// 队列因前一篇出错而停止时，说明原因
			return item.detail === label ? label : `${label}：${item.detail}`;
		default:
			return label;
	}
}
