import { Plugin, TFile } from "obsidian";
import { ServerClient } from "./api/client";
import { mergeSettings, type BabelReaderSettings } from "./core/settings-model";
import type { ViewMode } from "./core/types";
import { TranslationJobs } from "./jobs/translation-jobs";
import { BabelReaderSettingTab } from "./settings";
import { TranslationStore } from "./store/translation-store";
import { ModeSwitcher } from "./view/mode-switcher";

/** 入口：只做注册，业务逻辑在各模块里 */
export default class BabelReaderPlugin extends Plugin {
	settings!: BabelReaderSettings;
	client!: ServerClient;
	private store!: TranslationStore;
	private jobs!: TranslationJobs;
	private switcher!: ModeSwitcher;

	async onload(): Promise<void> {
		this.settings = mergeSettings(await this.loadData());
		this.client = new ServerClient(() => ({
			serverUrl: this.settings.serverUrl,
			token: this.settings.token,
		}));
		this.store = new TranslationStore(
			this.app,
			() => this.settings.translationsDir,
			() => this.settings.langOut,
		);

		const statusEl = this.addStatusBarItem();
		this.jobs = new TranslationJobs(this.app, this.client, this.store, () => this.settings, statusEl);
		this.registerDomEvent(statusEl, "click", () => void this.jobs.onStatusClick());
		this.register(() => this.jobs.dispose());

		this.switcher = new ModeSwitcher(this.app, this.store, (file) => void this.jobs.translate(file));
		this.register(() => this.switcher.detachAll());
		this.register(this.store.onChange(() => this.switcher.refreshAll()));

		this.addSettingTab(new BabelReaderSettingTab(this.app, this));
		this.registerCommands();

		this.registerEvent(this.app.workspace.on("layout-change", () => this.switcher.refreshAll()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.switcher.refreshAll()));

		const vault = this.app.vault;
		this.registerEvent(vault.on("delete", (file) => this.store.handleDelete(file)));
		this.registerEvent(
			vault.on("rename", (file, oldPath) => void this.store.handleRename(file, oldPath)),
		);
		this.registerEvent(vault.on("create", (file) => void this.store.handleCreateOrModify(file)));
		this.registerEvent(vault.on("modify", (file) => void this.store.handleCreateOrModify(file)));

		this.app.workspace.onLayoutReady(() => {
			void this.store.rebuild();
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async onTranslationsDirChanged(): Promise<void> {
		await this.store.rebuild();
	}

	private registerCommands(): void {
		this.addCommand({
			id: "translate-current-pdf",
			name: "翻译当前 PDF",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") return false;
				// 译文文件本身不再翻译
				if (this.store.index.isOutputPath(file.path)) return false;
				if (!checking) void this.jobs.translate(file);
				return true;
			},
		});

		this.addCommand({
			id: "cancel-translation",
			name: "取消翻译",
			checkCallback: (checking) => {
				if (!this.jobs.isRunning) return false;
				if (!checking) void this.jobs.cancel();
				return true;
			},
		});

		const modes: [ViewMode, string, string][] = [
			["original", "switch-to-original", "切换到原文"],
			["mono", "switch-to-translation", "切换到译文"],
			["dual", "switch-to-side-by-side", "切换到对照"],
		];
		for (const [mode, id, name] of modes) {
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => this.switcher.switchActive(mode, checking),
			});
		}
	}
}
