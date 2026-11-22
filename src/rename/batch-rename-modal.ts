import { Modal, Setting, type App, type ButtonComponent, type TFile } from "obsidian";
import { titleToFileName } from "../core/naming";
import type { TitleSuggestion } from "../core/title";
import { targetPathFor } from "./target-path";

export interface BatchRenameRow {
	file: TFile;
	suggestion: TitleSuggestion | null;
	/** 识别失败的原因 */
	error: string | null;
}

interface RowState extends BatchRenameRow {
	checked: boolean;
	value: string;
	descEl: HTMLElement | null;
	/** 最近一次计算出的目标路径；不改名时为 null */
	target: string | null;
}

/**
 * 批量按标题重命名：每行一个勾选框和可修改的新文件名，最后一次确认。
 * 识别失败或文件名没有变化的行默认不勾选；同一批里的新文件名互相避开重名。
 */
export class BatchRenameModal extends Modal {
	private rows: RowState[];
	private submitButton: ButtonComponent | null = null;
	private submitted = false;

	constructor(
		app: App,
		rows: readonly BatchRenameRow[],
		private readonly onSubmit: (plans: { file: TFile; path: string }[]) => Promise<void>,
	) {
		super(app);
		this.rows = rows.map((r) => {
			const value = r.suggestion ? (titleToFileName(r.suggestion.primary.title) ?? r.file.basename) : r.file.basename;
			return { ...r, value, checked: r.suggestion !== null, descEl: null, target: null };
		});
		// 文件名本来就是标题的，默认不勾选
		this.recompute();
		for (const r of this.rows) if (r.target === r.file.path) r.checked = false;
	}

	onOpen(): void {
		this.setTitle(`按论文标题重命名（${this.rows.length} 篇）`);
		this.modalEl.addClass("babel-reader-batch-rename-modal");
		const el = this.contentEl;
		el.addClass("babel-reader-rename");
		el.createEl("p", {
			cls: "setting-item-description",
			text: "勾选要改名的文件，可以先修改新文件名。已有译文的，译文目录和译文文件会一并改名。",
		});

		const list = el.createDiv({ cls: "babel-reader-batch-rename-list" });
		for (const row of this.rows) this.renderRow(list, row);

		new Setting(el)
			.addButton((b) => b.setButtonText("全选").onClick(() => this.setAll(true)))
			.addButton((b) => b.setButtonText("全不选").onClick(() => this.setAll(false)))
			.addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
			.addButton((b) => {
				this.submitButton = b;
				b.setCta().onClick(() => void this.submit());
			});
		this.refresh();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private toggles = new Map<RowState, (v: boolean) => void>();

	private renderRow(parent: HTMLElement, row: RowState): void {
		const s = new Setting(parent).setName(row.file.name);
		s.settingEl.addClass("babel-reader-batch-rename-row");
		row.descEl = s.descEl;
		s.addText((t) => {
			t.inputEl.addClass("babel-reader-rename-input");
			t.setPlaceholder("新文件名").setValue(row.value).onChange((v) => {
				row.value = v;
				// 修改了文件名就默认要改
				if (!row.checked && v.trim() !== "") {
					row.checked = true;
					this.toggles.get(row)?.(true);
				}
				this.refresh();
			});
		});
		s.addToggle((t) => {
			t.setValue(row.checked).onChange((v) => {
				row.checked = v;
				this.refresh();
			});
			this.toggles.set(row, (v) => t.setValue(v));
		});
	}

	private setAll(checked: boolean): void {
		for (const r of this.rows) {
			r.checked = checked;
			this.toggles.get(r)?.(checked);
		}
		this.refresh();
	}

	/** 按顺序计算每行的目标路径：前面勾选的行占用的名字，后面的行要避开 */
	private recompute(): void {
		const claimed = new Set<string>();
		for (const r of this.rows) {
			r.target = null;
			if (!r.checked) continue;
			const path = targetPathFor(r.file, r.value, claimed);
			r.target = path;
			if (path !== null) claimed.add(path.toLowerCase());
		}
	}

	private refresh(): void {
		this.recompute();
		for (const r of this.rows) {
			const el = r.descEl;
			if (!el) continue;
			el.empty();
			if (r.suggestion) {
				el.createDiv({ text: `识别到：${r.suggestion.primary.title}` });
			} else if (r.error) {
				el.createDiv({ cls: "babel-reader-rename-warning", text: r.error });
			}
			let line: string;
			let warn = false;
			if (!r.checked) line = "不改名";
			else if (r.target === null) {
				line = "文件名不能为空";
				warn = true;
			} else if (r.target === r.file.path) line = "文件名没有变化";
			else line = `→ ${r.target}`;
			el.createDiv({ cls: warn ? "babel-reader-rename-warning" : "babel-reader-rename-preview", text: line });
		}
		const n = this.plans().length;
		this.submitButton?.setButtonText(`重命名（${n} 篇）`).setDisabled(n === 0);
	}

	private plans(): { file: TFile; path: string }[] {
		return this.rows.flatMap((r) =>
			r.checked && r.target !== null && r.target !== r.file.path ? [{ file: r.file, path: r.target }] : [],
		);
	}

	private async submit(): Promise<void> {
		if (this.submitted) return;
		this.recompute();
		const plans = this.plans();
		if (plans.length === 0) return;
		this.submitted = true;
		this.close();
		await this.onSubmit(plans);
	}
}
