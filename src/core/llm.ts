import { errorMessage, ValidationError } from "./errors";
import { localLaunchTarget } from "./launch";
import { isRecord } from "./validate";

/**
 * 插件设置里的一个大模型配置（OpenAI 兼容接口）。
 * API key 不在这里：secretId 只是 Obsidian 密钥存储（SecretStorage）里那条密钥的名称。
 */
export interface LlmProfile {
	id: string;
	name: string;
	baseUrl: string;
	model: string;
	secretId: string;
	qps: number;
	/** 空字符串表示不发送 */
	temperature: string;
	/** 秒；空字符串表示用服务端默认 */
	timeout: string;
	/** 关闭思考：按接口地址换成对应服务商的请求字段（见 thinkingOffBody） */
	disableThinking: boolean;
	/** 高级：JSON 对象文本，原样合并进请求；空字符串表示不发送。与关闭思考冲突时以它为准 */
	extraBody: string;
}

/** 随任务提交给服务端的大模型配置（POST /v1/jobs 的 options.llm） */
export interface LlmJobOptions {
	name: string;
	base_url: string;
	api_key: string;
	model: string;
	qps: number;
	temperature: string | null;
	timeout: string | null;
	extra_body: Record<string, unknown> | null;
}

export const DEFAULT_QPS = 4;

export function newLlmProfile(id: string): LlmProfile {
	return {
		id,
		name: "新配置",
		baseUrl: "",
		model: "",
		secretId: "",
		qps: DEFAULT_QPS,
		temperature: "",
		timeout: "",
		disableThinking: false,
		extraBody: "",
	};
}

/**
 * 关闭思考对应的请求字段。各家写法不同：
 * - 通义千问（DashScope 兼容模式）：enable_thinking: false
 * - DeepSeek、智谱 GLM、豆包等：thinking: { type: "disabled" }
 */
export function thinkingOffBody(baseUrl: string): Record<string, unknown> {
	let host = "";
	try {
		host = new URL(baseUrl.trim()).hostname.toLowerCase();
	} catch {
		// 地址不合法时 buildLlmJobOptions 会报错，这里按默认写法
	}
	if (host === "dashscope.aliyuncs.com" || host.endsWith(".dashscope.aliyuncs.com")) {
		return { enable_thinking: false };
	}
	return { thinking: { type: "disabled" } };
}

/** 旧版设置把关闭思考写在额外请求参数里：认出这两种写法，迁移成开关 */
function isThinkingOffJson(text: string): boolean {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return false;
	}
	const s = JSON.stringify(value);
	return s === '{"thinking":{"type":"disabled"}}' || s === '{"enable_thinking":false}';
}

/** 6 字节随机数 → 12 位十六进制 id */
export function llmProfileIdFromBytes(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 从 data.json 读出的任意数据里取出大模型配置列表；字段不对的条目修正或丢弃 */
export function parseLlmProfiles(raw: unknown): LlmProfile[] {
	if (!Array.isArray(raw)) return [];
	const out: LlmProfile[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!isRecord(item) || typeof item.id !== "string" || item.id === "" || seen.has(item.id)) continue;
		seen.add(item.id);
		const base = newLlmProfile(item.id);
		const str = (key: Exclude<keyof LlmProfile, "qps" | "disableThinking">): string => {
			const v = item[key];
			return typeof v === "string" ? v : base[key];
		};
		const qps = item.qps;
		let extraBody = str("extraBody");
		let disableThinking = item.disableThinking === true;
		if (typeof item.disableThinking !== "boolean" && isThinkingOffJson(extraBody)) {
			disableThinking = true;
			extraBody = "";
		}
		out.push({
			id: item.id,
			name: str("name"),
			baseUrl: str("baseUrl"),
			model: str("model"),
			secretId: str("secretId"),
			qps: typeof qps === "number" && Number.isInteger(qps) && qps >= 1 ? qps : DEFAULT_QPS,
			temperature: str("temperature"),
			timeout: str("timeout"),
			disableThinking,
			extraBody,
		});
	}
	return out;
}

/** 解析「额外请求参数」：必须是 JSON 对象；空白返回 null */
export function parseExtraBody(text: string): Record<string, unknown> | null {
	if (text.trim() === "") return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new ValidationError("额外请求参数不是合法的 JSON");
	}
	if (!isRecord(value)) throw new ValidationError("额外请求参数必须是 JSON 对象，形如 {\"key\": ...}");
	return value;
}

const NUMBER = /^\d+(\.\d+)?$/;

function optionalNumber(raw: string, label: string): string | null {
	const v = raw.trim();
	if (v === "") return null;
	if (!NUMBER.test(v)) throw new ValidationError(`${label}应为非负数字`);
	return v;
}

/** 校验一个配置并拼成任务参数；有问题时抛出带中文说明的 ValidationError */
export function buildLlmJobOptions(profile: LlmProfile, apiKey: string): LlmJobOptions {
	const label = profile.name.trim() || "未命名";
	const where = `大模型配置「${label}」`;
	let url: URL;
	try {
		url = new URL(profile.baseUrl.trim());
	} catch {
		throw new ValidationError(`${where}的接口地址不合法`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ValidationError(`${where}的接口地址必须以 http:// 或 https:// 开头`);
	}
	const model = profile.model.trim();
	if (model === "") throw new ValidationError(`${where}没有填写模型`);
	const key = apiKey.trim();
	if (key === "") throw new ValidationError(`${where}没有设置 API key`);
	if (!Number.isInteger(profile.qps) || profile.qps < 1 || profile.qps > 100) {
		throw new ValidationError(`${where}的每秒请求数应为 1 到 100 的整数`);
	}
	let custom: Record<string, unknown> | null;
	try {
		custom = parseExtraBody(profile.extraBody);
	} catch (err) {
		throw new ValidationError(`${where}的${errorMessage(err)}`);
	}
	// 手填的额外请求参数放在后面：同名字段以它为准
	const merged = {
		...(profile.disableThinking ? thinkingOffBody(profile.baseUrl) : {}),
		...custom,
	};
	const extraBody = Object.keys(merged).length > 0 ? merged : null;
	return {
		name: label,
		base_url: profile.baseUrl.trim(),
		api_key: key,
		model,
		qps: profile.qps,
		temperature: optionalNumber(profile.temperature, `${where}的温度`),
		timeout: optionalNumber(profile.timeout, `${where}的超时`),
		extra_body: extraBody,
	};
}

/**
 * 能否把 API key 发给这个服务地址：本机地址，或 https。
 * 局域网里的 http 是明文，插件拒绝发送密钥。
 */
export function canSendSecretTo(serverUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(serverUrl.trim());
	} catch {
		return false;
	}
	if (url.protocol === "https:") return true;
	return url.protocol === "http:" && localLaunchTarget(`${url.protocol}//${url.host}`) !== null;
}

// ---- 设置页「使用的配置」下拉框的取值 ----------------------------------

export type ProfileChoice =
	| { kind: "server-default" }
	| { kind: "server"; name: string }
	| { kind: "plugin"; id: string };

export function encodeProfileChoice(c: ProfileChoice): string {
	if (c.kind === "server") return `server:${c.name}`;
	if (c.kind === "plugin") return `plugin:${c.id}`;
	return "";
}

export function decodeProfileChoice(value: string): ProfileChoice {
	if (value.startsWith("server:")) return { kind: "server", name: value.slice("server:".length) };
	if (value.startsWith("plugin:")) return { kind: "plugin", id: value.slice("plugin:".length) };
	return { kind: "server-default" };
}
