import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { ApiError, errorMessage } from "../core/errors";
import { buildMultipart, makeBoundary } from "../core/multipart";
import type { HealthInfo, JobOptions, JobStatus, OutputKind } from "../core/types";
import { buildApiUrl } from "../core/url";
import {
	isRecord,
	parseHealth,
	parseJobCreated,
	parseJobStatus,
	parseProfiles,
} from "../core/validate";

export interface ServerConnection {
	serverUrl: string;
	token: string;
}

/**
 * 翻译服务的 HTTP 客户端。
 * 一律用 requestUrl（无 CORS 限制、移动端可用），网络访问只发往用户配置的服务地址。
 */
export class ServerClient {
	constructor(private readonly getConnection: () => ServerConnection) {}

	async health(): Promise<HealthInfo> {
		const res = await this.request({ method: "GET", path: "/health" });
		return parseHealth(res.json);
	}

	async profiles(): Promise<string[]> {
		const res = await this.request({ method: "GET", path: "/profiles" });
		return parseProfiles(res.json);
	}

	async createJob(pdf: ArrayBuffer, options: JobOptions): Promise<string> {
		const random = new Uint8Array(16);
		crypto.getRandomValues(random);
		const { body, contentType } = buildMultipart(
			[
				// 文件名只用于服务端日志，固定用 ASCII，避免编码问题
				{ name: "file", filename: "source.pdf", contentType: "application/pdf", data: pdf },
				{ name: "options", value: JSON.stringify(options) },
			],
			makeBoundary(random),
		);
		const res = await this.request({ method: "POST", path: "/jobs", body, contentType });
		return parseJobCreated(res.json);
	}

	async getJob(jobId: string): Promise<JobStatus> {
		const res = await this.request({ method: "GET", path: `/jobs/${encodeURIComponent(jobId)}` });
		return parseJobStatus(res.json);
	}

	async cancelJob(jobId: string): Promise<void> {
		await this.request({ method: "DELETE", path: `/jobs/${encodeURIComponent(jobId)}` });
	}

	async downloadOutput(jobId: string, kind: OutputKind): Promise<ArrayBuffer> {
		const res = await this.request({
			method: "GET",
			path: `/jobs/${encodeURIComponent(jobId)}/files/${kind}`,
		});
		const buf = res.arrayBuffer;
		if (!looksLikePdf(buf)) throw new ApiError(res.status, `服务返回的 ${kind} 文件不是 PDF`);
		return buf;
	}

	private async request(opts: {
		method: string;
		path: string;
		body?: ArrayBuffer | string;
		contentType?: string;
	}): Promise<RequestUrlResponse> {
		const conn = this.getConnection();
		let url: string;
		try {
			url = buildApiUrl(conn.serverUrl, opts.path);
		} catch {
			throw new ApiError(0, "服务地址不合法，请在设置里检查");
		}
		const headers: Record<string, string> = {};
		const token = conn.token.trim();
		if (token !== "") headers.Authorization = `Bearer ${token}`;

		const param: RequestUrlParam = { url, method: opts.method, headers, throw: false };
		if (opts.body !== undefined) param.body = opts.body;
		if (opts.contentType !== undefined) param.contentType = opts.contentType;

		let res: RequestUrlResponse;
		try {
			res = await requestUrl(param);
		} catch (err) {
			throw new ApiError(0, `无法连接翻译服务（${errorMessage(err)}）`);
		}
		if (res.status < 200 || res.status >= 300) {
			throw new ApiError(res.status, describeHttpError(res));
		}
		return res;
	}
}

function looksLikePdf(buf: ArrayBuffer): boolean {
	const head = new Uint8Array(buf, 0, Math.min(5, buf.byteLength));
	return String.fromCharCode(...head) === "%PDF-";
}

function describeHttpError(res: RequestUrlResponse): string {
	let detail = "";
	try {
		const data: unknown = JSON.parse(res.text);
		if (isRecord(data) && typeof data.detail === "string") detail = data.detail;
	} catch {
		// 响应不是 JSON，忽略
	}
	if (res.status === 401) return "访问令牌不正确或缺失";
	const suffix = detail ? `：${detail}` : "";
	return `服务返回 HTTP ${res.status}${suffix}`;
}
