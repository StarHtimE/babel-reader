import { debounce, Notice, PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import type { ServerClient } from "./api/client";
import { errorMessage } from "./core/errors";
import { DEFAULT_SETTINGS, type BabelReaderSettings } from "./core/settings-model";
import { normalizeServerUrl } from "./core/url";
import type { ServerLauncher } from "./launcher/server-launcher";

export interface SettingsHost extends Plugin {
	settings: BabelReaderSettings;
	client: ServerClient;
	launcher: ServerLauncher;
	saveSettings(): Promise<void>;
	/** 译文目录改了之后重建索引 */
	onTranslationsDirChanged(): Promise<void>;
}

// 声明式设置 API（getSettingDefinitions）需要 1.13.0，而 minAppVersion 是 1.6.0，暂用 display()
export class BabelReaderSettingTab extends PluginSettingTab {
	/** 最近一次从服务端读到的 profile 列表（只在内存里） */
	private profiles: string[] = [];

	constructor(
		app: App,
		private readonly host: SettingsHost,
	) {
		super(app, host);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.host.settings;

		new Setting(containerEl).setName("翻译服务").setHeading();

		new Setting(containerEl)
			.setName("服务地址")
			.setDesc("Babel Reader 翻译服务的地址。插件只会连接这个地址。")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.serverUrl)
					.setValue(s.serverUrl)
					.onChange(async (v) => {
						s.serverUrl = v.trim();
						await this.host.saveSettings();
					}),
			)
			.addButton((b) =>
				b.setButtonText("测试连接").onClick(async () => {
					await this.testConnection(b.buttonEl);
				}),
			);

		new Setting(containerEl)
			.setName("访问令牌")
			.setDesc("与服务端配置里的令牌一致；仅本机使用且服务端未设置令牌时可留空。")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s.token).onChange(async (v) => {
					s.token = v.trim();
					await this.host.saveSettings();
				});
			});

		// 自动启动要运行本机程序，只有桌面端有
		if (this.host.launcher.supported) {
			new Setting(containerEl)
				.setName("自动启动服务")
				.setDesc(
					"点击翻译时如果连不上本机的翻译服务，就在后台启动它。只对本机地址生效；由插件启动的服务会在关闭 Obsidian 时一并结束。",
				)
				.addToggle((t) =>
					t.setValue(s.autoStartServer).onChange(async (v) => {
						s.autoStartServer = v;
						await this.host.saveSettings();
					}),
				);

			new Setting(containerEl)
				.setName("服务目录")
				.setDesc(
					"Babel Reader 源码里的 server 文件夹的完整路径。需要已在其中运行过 uv sync 并创建好 config.toml；服务日志写在该目录的 server.log。",
				)
				.addText((t) =>
					t
						.setPlaceholder("D:\\babel-reader\\server")
						.setValue(s.serverDir)
						.onChange(async (v) => {
							s.serverDir = v.trim();
							await this.host.saveSettings();
						}),
				)
				.addButton((b) =>
					b.setButtonText("检查").onClick(() => {
						this.checkServerDir();
					}),
				);
		}

		new Setting(containerEl)
			.setName("翻译配置")
			.setDesc("对应服务端配置里的 profile。留空则使用服务端的第一个。")
			.addDropdown((d) => {
				d.addOption("", "（服务端默认）");
				const names = new Set(this.profiles);
				if (s.profile !== "") names.add(s.profile);
				for (const name of names) d.addOption(name, name);
				d.setValue(s.profile).onChange(async (v) => {
					s.profile = v;
					await this.host.saveSettings();
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon("refresh-cw")
					.setTooltip("从服务端读取")
					.onClick(async () => {
						await this.loadProfiles();
					}),
			);

		new Setting(containerEl).setName("翻译").setHeading();

		new Setting(containerEl)
			.setName("源语言")
			.setDesc("语言代码，如 en。")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.langIn)
					.setValue(s.langIn)
					.onChange(async (v) => {
						s.langIn = v.trim();
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("目标语言")
			.setDesc("语言代码，如 zh。")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.langOut)
					.setValue(s.langOut)
					.onChange(async (v) => {
						s.langOut = v.trim();
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("生成对照版")
			.setDesc("原文和译文左右并排在同一页。关闭则只生成译文。")
			.addToggle((t) =>
				t.setValue(s.generateDual).onChange(async (v) => {
					s.generateDual = v;
					await this.host.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("对照版译文在左")
			.setDesc("只影响对照版里左右的顺序，不影响页码。")
			.addToggle((t) =>
				t.setValue(s.dualTranslateFirst).onChange(async (v) => {
					s.dualTranslateFirst = v;
					await this.host.saveSettings();
				}),
			);

		new Setting(containerEl).setName("存储").setHeading();

		new Setting(containerEl)
			.setName("译文目录")
			.setDesc("译文和清单的存放位置（仓库内路径）。修改后会重新扫描。")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.translationsDir)
					.setValue(s.translationsDir)
					// 停止输入一会儿再保存，避免每敲一个字就重扫一次
					.onChange(
						debounce(
							async (v: string) => {
								const dir = v.trim();
								if (dir === s.translationsDir) return;
								s.translationsDir = dir;
								await this.host.saveSettings();
								await this.host.onTranslationsDirChanged();
							},
							800,
							true,
						),
					),
			);
	}

	private async testConnection(button: HTMLButtonElement): Promise<void> {
		if (normalizeServerUrl(this.host.settings.serverUrl) === null) {
			new Notice("服务地址不合法，应形如 http://127.0.0.1:8891");
			return;
		}
		button.disabled = true;
		try {
			const h = await this.host.client.health();
			new Notice(
				`连接成功：服务 ${h.server_version}，pdf2zh_next ${h.pdf2zh_next_version}，BabelDOC ${h.babeldoc_version}`,
			);
			await this.loadProfiles(false);
		} catch (err) {
			new Notice(`连接失败：${errorMessage(err)}`, 8000);
		} finally {
			button.disabled = false;
		}
	}

	private checkServerDir(): void {
		try {
			const problems = this.host.launcher.checkServerDir(this.host.settings.serverDir);
			if (problems.length === 0) {
				new Notice("服务目录没有问题");
			} else {
				new Notice(problems.join("\n"), 10000);
			}
		} catch (err) {
			new Notice(`检查失败：${errorMessage(err)}`, 8000);
		}
	}

	private async loadProfiles(notify = true): Promise<void> {
		try {
			this.profiles = await this.host.client.profiles();
			if (notify) new Notice(`读取到 ${this.profiles.length} 个翻译配置`);
			this.display();
		} catch (err) {
			new Notice(`读取翻译配置失败：${errorMessage(err)}`, 8000);
		}
	}
}
