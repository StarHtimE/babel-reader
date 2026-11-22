import { Plugin, TFile } from "obsidian";
import { ServerClient } from "./api/client";
import { mergeSettings, type BabelReaderSettings } from "./core/settings-model";
import type { ViewMode } from "./core/types";
import { TranslationJobs } from "./jobs/translation-jobs";
import { ServerLauncher } from "./launcher/server-launcher";
import { TitleRenamer } from "./rename/title-renamer";
import { BabelReaderSettingTab } from "./settings";
import { TranslationStore } from "./store/translation-store";
import { ModeSwitcher } from "./view/mode-switcher";
import { OrphanPrompt } from "./view/orphan-prompt";

/** 入口：只做注册，业务逻辑在各模块里 */
export default class BabelReaderPlugin extends Plugin {
	settings!: BabelReaderSettings;
	client!: ServerClient;
	launcher!: ServerLauncher;
	private store!: TranslationStore;
	private jobs!: TranslationJobs;
	private switcher!: ModeSwitcher;
	private renamer!: TitleRenamer;

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

		// 插件自己启动的服务：卸载插件或退出 Obsidian 时结束（onunload 在退出时不一定会被调用）
		this.launcher = new ServerLauncher(this.client);
		this.register(() => this.launcher.stop());
		this.registerEvent(this.app.workspace.on("quit", () => this.launcher.stop()));

		const statusEl = this.addStatusBarItem();
		this.jobs = new TranslationJobs(
			this.app,
			this.client,
			this.store,
			this.launcher,
			() => this.settings,
			statusEl,
		);
		this.registerDomEvent(statusEl, "click", () => void this.jobs.onStatusClick());
		this.register(() => this.jobs.dispose());

		this.renamer = new TitleRenamer(this.app, this.store);
		this.switcher = new ModeSwitcher(
			this.app,
			this.store,
			(file) => void this.jobs.translate(file),
			(file) => void this.renamer.run(file),
		);
		this.register(() => this.switcher.detachAll());
		this.register(this.store.onChange(() => this.switcher.refreshAll()));

		this.addSettingTab(new BabelReaderSettingTab(this.app, this));
		this.registerCommands();

		this.registerEvent(this.app.workspace.on("layout-change", () => this.switcher.refreshAll()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.switcher.refreshAll()));

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!this.renamer.canRename(file)) return;
				menu.addItem((item) =>
					item
						.setTitle("按论文标题重命名")
						.setIcon("pencil")
						.onClick(() => void this.renamer.run(file)),
				);
			}),
		);

		const orphans = new OrphanPrompt(this.app, this.store);
		this.register(() => orphans.dispose());
		this.register(this.store.onSourceDeleted((entries) => orphans.add(entries)));

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
			id: "rename-by-title",
			name: "按论文标题重命名当前 PDF",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!this.renamer.canRename(file)) return false;
				if (!checking) void this.renamer.run(file);
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
