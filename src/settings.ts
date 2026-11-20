import {
	debounce,
	Notice,
	PluginSettingTab,
	SecretComponent,
	Setting,
	type App,
	type Plugin,
} from "obsidian";
import type { ServerClient } from "./api/client";
import { errorMessage } from "./core/errors";
import {
	decodeProfileChoice,
	DEFAULT_QPS,
	encodeProfileChoice,
	llmProfileIdFromBytes,
	newLlmProfile,
	parseExtraBody,
	type LlmProfile,
	type ProfileChoice,
} from "./core/llm";
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

// 声明式设置 API（getSettingDefinitions）需要 1.13.0，而 minAppVersion 是 1.11.4，暂用 display()
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
					"点击翻译或「测试连接」时如果连不上本机的翻译服务，就在后台启动它。只对本机地址生效；由插件启动的服务会在关闭 Obsidian 时一并结束。",
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

		this.displayLlm(containerEl);

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
		// 放在对象里：在回调里赋值，TS 的控制流分析不会把它误判为恒为 null
		const progress: { notice: Notice | null } = { notice: null };
		try {
			const s = this.host.settings;
			const h = await this.host.launcher.connect(
				{ serverUrl: s.serverUrl, serverDir: s.serverDir, autoStart: s.autoStartServer },
				() => false,
				() => {
					// 0 表示不自动消失，就绪或失败后手动关掉
					progress.notice = new Notice("正在启动翻译服务…", 0);
				},
			);
			if (!h) return;
			new Notice(
				`连接成功：服务 ${h.server_version}，pdf2zh_next ${h.pdf2zh_next_version}，BabelDOC ${h.babeldoc_version}`,
			);
			await this.loadProfiles(false);
		} catch (err) {
			new Notice(`连接失败：${errorMessage(err)}`, 8000);
		} finally {
			progress.notice?.hide();
			button.disabled = false;
		}
	}

	/** 「大模型」分组：选用哪个配置，以及插件里的配置列表 */
	private displayLlm(containerEl: HTMLElement): void {
		const s = this.host.settings;
		new Setting(containerEl).setName("大模型").setHeading();

		const current: ProfileChoice =
			s.llmProfileId !== ""
				? { kind: "plugin", id: s.llmProfileId }
				: s.profile !== ""
					? { kind: "server", name: s.profile }
					: { kind: "server-default" };

		new Setting(containerEl)
			.setName("使用的配置")
			.setDesc(
				"选择下面在插件里添加的配置，或服务端 config.toml 里的 profile（点刷新按钮从服务端读取）。",
			)
			.addDropdown((d) => {
				for (const p of s.llmProfiles) {
					d.addOption(encodeProfileChoice({ kind: "plugin", id: p.id }), p.name || "未命名");
				}
				d.addOption(encodeProfileChoice({ kind: "server-default" }), "服务端默认（config.toml 的第一个）");
				const names = new Set(this.profiles);
				if (s.profile !== "") names.add(s.profile);
				for (const name of names) {
					d.addOption(encodeProfileChoice({ kind: "server", name }), `服务端：${name}`);
				}
				d.setValue(encodeProfileChoice(current)).onChange(async (v) => {
					const choice = decodeProfileChoice(v);
					s.llmProfileId = choice.kind === "plugin" ? choice.id : "";
					s.profile = choice.kind === "server" ? choice.name : "";
					await this.host.saveSettings();
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon("refresh-cw")
					.setTooltip("从服务端读取 profile")
					.onClick(async () => {
						await this.loadProfiles();
					}),
			);

		for (const profile of s.llmProfiles) this.displayLlmProfile(containerEl, profile);

		new Setting(containerEl)
			.setDesc("API key 保存在 Obsidian 的密钥存储里，插件设置文件只记录密钥的名称。")
			.addButton((b) =>
				b.setButtonText("添加大模型配置").onClick(async () => {
					const bytes = new Uint8Array(6);
					crypto.getRandomValues(bytes);
					const profile = newLlmProfile(llmProfileIdFromBytes(bytes));
					s.llmProfiles.push(profile);
					// 第一次添加时直接选用它
					if (s.llmProfileId === "" && s.profile === "") s.llmProfileId = profile.id;
					await this.host.saveSettings();
					this.display();
				}),
			);
	}

	private displayLlmProfile(containerEl: HTMLElement, p: LlmProfile): void {
		const s = this.host.settings;
		const save = () => this.host.saveSettings();

		new Setting(containerEl)
			.setName(`配置：${p.name || "未命名"}`)
			.setHeading()
			.addExtraButton((b) =>
				b
					.setIcon("trash")
					.setTooltip("删除这个配置（密钥存储里的 API key 不会被删除）")
					.onClick(async () => {
						s.llmProfiles = s.llmProfiles.filter((x) => x.id !== p.id);
						if (s.llmProfileId === p.id) s.llmProfileId = "";
						await save();
						this.display();
					}),
			);

		new Setting(containerEl).setName("名称").addText((t) =>
			t.setValue(p.name).onChange(async (v) => {
				p.name = v.trim();
				await save();
			}),
		);

		new Setting(containerEl)
			.setName("接口地址")
			.setDesc("OpenAI 兼容接口的地址。")
			.addText((t) =>
				t
					.setPlaceholder("https://api.deepseek.com")
					.setValue(p.baseUrl)
					.onChange(async (v) => {
						p.baseUrl = v.trim();
						await save();
					}),
			);

		new Setting(containerEl).setName("模型").addText((t) =>
			t
				.setPlaceholder("deepseek-chat")
				.setValue(p.model)
				.onChange(async (v) => {
					p.model = v.trim();
					await save();
				}),
		);

		new Setting(containerEl)
			.setName("关闭思考")
			.setDesc(
				"DeepSeek、通义千问、智谱 GLM、豆包等默认开启思考的模型建议打开：先推理再翻译会慢很多倍。OpenAI 等不支持这个参数的接口请关闭。",
			)
			.addToggle((t) =>
				t.setValue(p.disableThinking).onChange(async (v) => {
					p.disableThinking = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("API key")
			.setDesc("从 Obsidian 的密钥存储里选择或新建。")
			.addComponent((el) =>
				new SecretComponent(this.app, el).setValue(p.secretId).onChange(async (v) => {
					p.secretId = v ?? "";
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("每秒请求数")
			.setDesc("1 到 100 的整数，注意服务商的限流。")
			.addText((t) =>
				t
					.setPlaceholder(String(DEFAULT_QPS))
					.setValue(String(p.qps))
					.onChange(async (v) => {
						const n = Number(v.trim());
						// 输入到一半（如空字符串）时不改，翻译时还会再校验
						if (!Number.isInteger(n) || n < 1 || n > 100) return;
						p.qps = n;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("温度")
			.setDesc("可选；留空则不发送。")
			.addText((t) =>
				t.setValue(p.temperature).onChange(async (v) => {
					p.temperature = v.trim();
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("超时（秒）")
			.setDesc("可选；留空则用默认值。")
			.addText((t) =>
				t.setValue(p.timeout).onChange(async (v) => {
					p.timeout = v.trim();
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("额外请求参数（高级）")
			.setDesc(
				"一般不用填。JSON 对象，原样合并进每次请求，用于服务商的专有参数；与「关闭思考」冲突时以这里为准。",
			)
			.addTextArea((t) => {
				t.setPlaceholder('{"top_p": 0.9}')
					.setValue(p.extraBody)
					.onChange(async (v) => {
						p.extraBody = v;
						await save();
					});
				t.inputEl.addClass("babel-reader-json-input");
				// 离开输入框时检查一次 JSON，及早发现写错
				this.host.registerDomEvent(t.inputEl, "blur", () => {
					try {
						parseExtraBody(t.getValue());
					} catch (err) {
						new Notice(`「${p.name || "未命名"}」的${errorMessage(err)}`, 6000);
					}
				});
			});
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
