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
}

export interface JobStatus {
	state: JobState;
	stage: string | null;
	stage_progress: number;
	overall_progress: number;
	error?: string;
	outputs?: OutputKind[];
}

/** POST /v1/jobs 的 options 字段 */
export interface JobOptions {
	lang_in: string;
	lang_out: string;
	profile: string | null;
	pages: string | null;
	outputs: OutputKind[];
	dual_translate_first: boolean;
	ignore_cache: boolean;
	glossary_csv: string | null;
}

export function isTerminalState(state: JobState): boolean {
	return state === "done" || state === "error" || state === "cancelled";
}
