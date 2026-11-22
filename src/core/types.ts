import type { LlmJobOptions } from "./llm";

/** 服务端任务状态（与 HTTP 接口 v1 一致） */
export type JobState = "queued" | "running" | "done" | "error" | "cancelled";

/** 服务端可产出的译文种类 */
export type OutputKind = "mono" | "dual";

/** PDF 视图的三种显示模式 */
export type ViewMode = "original" | OutputKind;

export const OUTPUT_KINDS: readonly OutputKind[] = ["mono", "dual"];
export const VIEW_MODES: readonly ViewMode[] = ["original", "mono", "dual"];

export interface HealthInfo {
	ok: boolean;
	server_version: string;
	pdf2zh_next_version: string;
	babeldoc_version: string;
	/** 服务端支持的可选功能，如 "llm"（接受 options.llm）；旧版服务端为空 */
	features: string[];
}

/** 服务端接受插件提交的大模型配置（options.llm） */
export const FEATURE_LLM_OPTIONS = "llm";

/** 服务端支持 options.auto_extract_glossary，并会返回自动抽取的术语（extras 里的 "glossary"） */
export const FEATURE_GLOSSARY = "glossary";

export interface JobStatus {
	state: JobState;
	stage: string | null;
	stage_progress: number;
	overall_progress: number;
	error?: string;
	outputs?: OutputKind[];
	/** 完成时的额外结果，如 "glossary"（自动抽取的术语 CSV）；旧版服务端没有 */
	extras?: string[];
}

/** POST /v1/jobs 的 options 字段 */
export interface JobOptions {
	lang_in: string;
	lang_out: string;
	/** 服务端 config.toml 里的 profile 名；提供了 llm 时为 null */
	profile: string | null;
	/** 插件设置里的大模型配置，优先于 profile */
	llm: LlmJobOptions | null;
	pages: string | null;
	outputs: OutputKind[];
	dual_translate_first: boolean;
	ignore_cache: boolean;
	glossary_csv: string | null;
	/** 让上游先抽取术语、统一译法；旧版服务端忽略此字段 */
	auto_extract_glossary: boolean;
}

export function isTerminalState(state: JobState): boolean {
	return state === "done" || state === "error" || state === "cancelled";
}
