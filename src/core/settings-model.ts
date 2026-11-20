import type { JobOptions, OutputKind } from "./types";
import { isRecord } from "./validate";

export interface BabelReaderSettings {
	serverUrl: string;
	token: string;
	langIn: string;
	langOut: string;
	/** 空字符串表示使用服务端的第一个 profile */
	profile: string;
	translationsDir: string;
	generateDual: boolean;
	dualTranslateFirst: boolean;
	/** 点翻译时连不上本机服务，就自动启动它（仅桌面端） */
	autoStartServer: boolean;
	/** 服务目录：本项目的 server 文件夹（仓库外的系统路径） */
	serverDir: string;
}

export const DEFAULT_SETTINGS: Readonly<BabelReaderSettings> = {
	serverUrl: "http://127.0.0.1:8891",
	token: "",
	langIn: "en",
	langOut: "zh",
	profile: "",
	translationsDir: "_translations",
	generateDual: true,
	dualTranslateFirst: false,
	autoStartServer: true,
	serverDir: "",
};

/** 把 loadData() 读到的任意数据合并成完整设置，类型不对的字段回退默认值 */
export function mergeSettings(raw: unknown): BabelReaderSettings {
	const out: BabelReaderSettings = { ...DEFAULT_SETTINGS };
	if (!isRecord(raw)) return out;
	for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof BabelReaderSettings)[]) {
		const value = raw[key];
		if (typeof value === typeof DEFAULT_SETTINGS[key]) {
			(out as unknown as Record<string, unknown>)[key] = value;
		}
	}
	return out;
}

export function requestedOutputs(settings: BabelReaderSettings): OutputKind[] {
	return settings.generateDual ? ["mono", "dual"] : ["mono"];
}

export function buildJobOptions(
	settings: BabelReaderSettings,
	overrides: Partial<Pick<JobOptions, "pages" | "ignore_cache">> = {},
): JobOptions {
	return {
		lang_in: settings.langIn.trim() || DEFAULT_SETTINGS.langIn,
		lang_out: settings.langOut.trim() || DEFAULT_SETTINGS.langOut,
		profile: settings.profile.trim() || null,
		pages: overrides.pages ?? null,
		outputs: requestedOutputs(settings),
		dual_translate_first: settings.dualTranslateFirst,
		ignore_cache: overrides.ignore_cache ?? false,
		glossary_csv: null,
	};
}
