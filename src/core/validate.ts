import { ValidationError } from "./errors";
import type { HealthInfo, JobState, JobStatus, OutputKind } from "./types";
import { OUTPUT_KINDS } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectRecord(value: unknown, what: string): Record<string, unknown> {
	if (!isRecord(value)) throw new ValidationError(`${what} 不是对象`);
	return value;
}

export function expectString(obj: Record<string, unknown>, key: string, what: string): string {
	const v = obj[key];
	if (typeof v !== "string") throw new ValidationError(`${what}.${key} 应为字符串`);
	return v;
}

export function optionalString(
	obj: Record<string, unknown>,
	key: string,
	what: string,
): string | null {
	const v = obj[key];
	if (v === undefined || v === null) return null;
	if (typeof v !== "string") throw new ValidationError(`${what}.${key} 应为字符串或 null`);
	return v;
}

function expectNumber(obj: Record<string, unknown>, key: string, what: string): number {
	const v = obj[key];
	if (typeof v !== "number" || !Number.isFinite(v)) {
		throw new ValidationError(`${what}.${key} 应为数字`);
	}
	return v;
}

const JOB_STATES: readonly JobState[] = ["queued", "running", "done", "error", "cancelled"];

function isJobState(v: unknown): v is JobState {
	return typeof v === "string" && (JOB_STATES as readonly string[]).includes(v);
}

export function isOutputKind(v: unknown): v is OutputKind {
	return typeof v === "string" && (OUTPUT_KINDS as readonly string[]).includes(v);
}

function clampPercent(n: number): number {
	return Math.min(100, Math.max(0, n));
}

export function parseHealth(data: unknown): HealthInfo {
	const obj = expectRecord(data, "health");
	if (obj.ok !== true) throw new ValidationError("health.ok 不为 true");
	return {
		ok: true,
		server_version: expectString(obj, "server_version", "health"),
		pdf2zh_next_version: expectString(obj, "pdf2zh_next_version", "health"),
		babeldoc_version: expectString(obj, "babeldoc_version", "health"),
		// 旧版服务端没有这个字段：当作空列表
		features: Array.isArray(obj.features)
			? obj.features.filter((x): x is string => typeof x === "string")
			: [],
	};
}

export function parseProfiles(data: unknown): string[] {
	const obj = expectRecord(data, "profiles");
	const list = obj.profiles;
	if (!Array.isArray(list) || !list.every((x): x is string => typeof x === "string")) {
		throw new ValidationError("profiles.profiles 应为字符串数组");
	}
	return list;
}

export function parseJobCreated(data: unknown): string {
	const obj = expectRecord(data, "job");
	const id = expectString(obj, "job_id", "job");
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ValidationError("job.job_id 格式不正确");
	return id;
}

export function parseJobStatus(data: unknown): JobStatus {
	const obj = expectRecord(data, "status");
	const state = obj.state;
	if (!isJobState(state)) throw new ValidationError("status.state 取值不正确");
	const status: JobStatus = {
		state,
		stage: optionalString(obj, "stage", "status"),
		stage_progress: clampPercent(expectNumber(obj, "stage_progress", "status")),
		overall_progress: clampPercent(expectNumber(obj, "overall_progress", "status")),
	};
	const error = optionalString(obj, "error", "status");
	if (error !== null) status.error = error;
	if (obj.outputs !== undefined && obj.outputs !== null) {
		const outputs = obj.outputs;
		if (!Array.isArray(outputs) || !outputs.every(isOutputKind)) {
			throw new ValidationError("status.outputs 应为 mono / dual 组成的数组");
		}
		status.outputs = outputs;
	}
	return status;
}
