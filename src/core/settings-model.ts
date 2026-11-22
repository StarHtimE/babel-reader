import { parseLlmProfiles, type LlmJobOptions, type LlmProfile } from "./llm";
import type { JobOptions, OutputKind } from "./types";
import { isRecord } from "./validate";

export interface BabelReaderSettings {
	serverUrl: string;
	token: string;
	langIn: string;
	langOut: string;
	/** 服务端 config.toml 里的 profile 名；空字符串表示服务端的第一个。llmProfileId 非空时不用 */
	profile: string;
	/** 插件设置里的大模型配置；API key 存在 Obsidian 的密钥存储里 */
	llmProfiles: LlmProfile[];
	/** 选用的插件大模型配置 id；空字符串表示用服务端的 profile */
	llmProfileId: string;
	translationsDir: string;
	generateDual: boolean;
	dualTranslateFirst: boolean;
	/** 点翻译或测试连接时连不上本机服务，就自动启动它（仅桌面端） */
	autoStartServer: boolean;
	/** 服务目录：本项目的 server 文件夹（仓库外的系统路径） */
	serverDir: string;
	/** 全局术语表笔记的路径；空字符串表示没有 */
	glossaryPath: string;
	/** 文件夹术语表的笔记名（不含 .md）：原文所在文件夹及其上级里这个名字的笔记也会生效 */
	folderGlossaryName: string;
	/** 让上游先从论文里抽取术语、统一这次翻译的译法 */
	autoExtractGlossary: boolean;
	/** 把自动抽取的新术语（过滤后）追加到术语表的「待审核」小节；需要开着自动抽取 */
	writeBackGlossary: boolean;
}

export const DEFAULT_SETTINGS: Readonly<BabelReaderSettings> = {
	serverUrl: "http://127.0.0.1:8891",
	token: "",
	langIn: "en",
	langOut: "zh",
	profile: "",
	llmProfiles: [],
	llmProfileId: "",
	translationsDir: "_translations",
	generateDual: true,
	dualTranslateFirst: false,
	autoStartServer: true,
	serverDir: "",
	glossaryPath: "",
	folderGlossaryName: "术语表",
	autoExtractGlossary: true,
	writeBackGlossary: true,
};

/** 把 loadData() 读到的任意数据合并成完整设置，类型不对的字段回退默认值 */
export function mergeSettings(raw: unknown): BabelReaderSettings {
	// llmProfiles 每次都新建数组，不和 DEFAULT_SETTINGS 共用
	const out: BabelReaderSettings = { ...DEFAULT_SETTINGS, llmProfiles: [] };
	if (!isRecord(raw)) return out;
	for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof BabelReaderSettings)[]) {
		if (key === "llmProfiles") continue;
		const value = raw[key];
		if (typeof value === typeof DEFAULT_SETTINGS[key]) {
			(out as unknown as Record<string, unknown>)[key] = value;
		}
	}
	out.llmProfiles = parseLlmProfiles(raw.llmProfiles);
	return out;
}

/** 当前选用的插件大模型配置；没选或已被删除时返回 null */
export function activeLlmProfile(settings: BabelReaderSettings): LlmProfile | null {
	if (settings.llmProfileId === "") return null;
	return settings.llmProfiles.find((p) => p.id === settings.llmProfileId) ?? null;
}

/** 实际使用的目标语言：没填时用默认值 */
export function langOutOf(settings: BabelReaderSettings): string {
	return settings.langOut.trim() || DEFAULT_SETTINGS.langOut;
}

export function requestedOutputs(settings: BabelReaderSettings): OutputKind[] {
	return settings.generateDual ? ["mono", "dual"] : ["mono"];
}

export function buildJobOptions(
	settings: BabelReaderSettings,
	overrides: Partial<Pick<JobOptions, "pages" | "ignore_cache" | "glossary_csv">> = {},
	llm: LlmJobOptions | null = null,
): JobOptions {
	return {
		lang_in: settings.langIn.trim() || DEFAULT_SETTINGS.langIn,
		lang_out: langOutOf(settings),
		profile: llm ? null : settings.profile.trim() || null,
		llm,
		pages: overrides.pages ?? null,
		outputs: requestedOutputs(settings),
		dual_translate_first: settings.dualTranslateFirst,
		ignore_cache: overrides.ignore_cache ?? false,
		glossary_csv: overrides.glossary_csv ?? null,
		auto_extract_glossary: settings.autoExtractGlossary,
	};
}
