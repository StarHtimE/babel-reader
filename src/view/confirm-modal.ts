import { Modal, Setting, type App } from "obsidian";

/** 简单的确认对话框，resolve(true) 表示用户确认 */
export function confirmDialog(
	app: App,
	opts: { title: string; message: string; confirmText: string; cancelText?: string },
): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new ConfirmModal(app, opts, resolve);
		modal.open();
	});
}

class ConfirmModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly opts: { title: string; message: string; confirmText: string; cancelText?: string },
		private readonly done: (ok: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.opts.title);
		this.contentEl.createEl("p", { text: this.opts.message });
		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText(this.opts.cancelText ?? "取消").onClick(() => this.finish(false)),
			)
			.addButton((b) =>
				b
					.setButtonText(this.opts.confirmText)
					.setCta()
					.onClick(() => this.finish(true)),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.done(false);
		}
	}

	private finish(ok: boolean): void {
		this.settled = true;
		this.done(ok);
		this.close();
	}
}
