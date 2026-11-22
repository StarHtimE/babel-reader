import { Plugin, TFile } from "obsidian";
import { ServerClient } from "./api/client";
import { mergeSettings, type BabelReaderSettings } from "./core/settings-model";
import type { ViewMode } from "./core/types";
import { BatchActions } from "./jobs/batch-actions";
import { TranslationJobs } from "./jobs/translation-jobs";
import { ServerLauncher } from "./launcher/server-launcher";
import { TitleRenamer } from "./rename/title-renamer";
import { BabelReaderSettingTab } from "./settings";
import { StaleChecker } from "./store/stale-checker";
import { TranslationStore } from "./store/translation-store";
import { ModeSwitcher } from "./view/mode-switcher";
import { OrphanPrompt } from "./view/orphan-prompt";
import { isPdfView } from "./view/pdf-internals";
import { QueueModal } from "./view/queue-modal";

/** 入口：只做注册，业务逻辑在各模块里 */
export default class BabelReaderPlugin extends Plugin {
	settings!: BabelReaderSettings;
	client!: ServerClient;
	launcher!: ServerLauncher;
	private store!: TranslationStore;
	private jobs!: TranslationJobs;
	private switcher!: ModeSwitcher;
	private renamer!: TitleRenamer;
	private batch!: BatchActions;

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

		const stale = new StaleChecker(this.app, this.store);

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
			stale,
			() => this.settings,
			statusEl,
		);
		this.registerDomEvent(statusEl, "click", () => this.openQueue());
		this.register(() => this.jobs.dispose());

		this.renamer = new TitleRenamer(this.app, this.store);
		this.switcher = new ModeSwitcher(
			this.app,
			this.store,
			stale,
			(file) => this.jobs.translate(file),
			(file) => void this.renamer.run(file),
		);
		this.register(() => this.switcher.detachAll());
		this.register(this.store.onChange(() => this.switcher.refreshAll()));
		this.register(stale.onChange(() => this.switcher.refreshAll()));

		this.addSettingTab(new BabelReaderSettingTab(this.app, this));
		this.registerCommands();

		this.registerEvent(this.app.workspace.on("layout-change", () => this.switcher.refreshAll()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.switcher.refreshAll()));

		// 文件列表右键菜单：单个 PDF、文件夹、多选
		this.batch = new BatchActions(this.app, this.store, stale, this.jobs, this.renamer, () => this.settings);
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => this.batch.addMenuItems(menu, [file])));
		this.registerEvent(this.app.workspace.on("files-menu", (menu, files) => this.batch.addMenuItems(menu, files)));

		const orphans = new OrphanPrompt(this.app, this.store);
		this.register(() => orphans.dispose());
		this.register(this.store.onSourceDeleted((entries) => orphans.add(entries)));

		const vault = this.app.vault;
		this.registerEvent(
			vault.on("delete", (file) => {
				stale.handleDelete(file);
				this.store.handleDelete(file);
			}),
		);
		this.registerEvent(
			vault.on("rename", (file, oldPath) => {
				stale.handleRename(file, oldPath);
				void this.store.handleRename(file, oldPath);
			}),
		);
		this.registerEvent(vault.on("create", (file) => void this.store.handleCreateOrModify(file)));
		this.registerEvent(
			vault.on("modify", (file) => {
				void this.store.handleCreateOrModify(file);
				stale.handleModify(file);
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			void this.store.rebuild();
		});
	}

	private openQueue(): void {
		new QueueModal(this.app, this.jobs).open();
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
				if (!checking) this.jobs.translate(file);
				return true;
			},
		});

		this.addCommand({
			id: "translate-pages",
			name: "翻译当前 PDF 的指定页…",
			checkCallback: (checking) => {
				// PDF 视图类不公开，看最近活动的 leaf
				const view = this.app.workspace.getMostRecentLeaf()?.view;
				if (!isPdfView(view) || !view.file || !this.store.isSourcePdf(view.file)) return false;
				if (!checking) this.batch.translatePages(view.file, view);
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
			id: "show-translation-queue",
			name: "查看翻译队列",
			callback: () => this.openQueue(),
		});

		this.addCommand({
			id: "cancel-translation",
			name: "取消全部翻译",
			checkCallback: (checking) => {
				if (!this.jobs.isRunning) return false;
				if (!checking) this.jobs.cancelAll();
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
