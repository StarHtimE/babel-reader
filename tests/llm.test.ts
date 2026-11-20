import { describe, expect, it } from "vitest";
import {
	buildLlmJobOptions,
	canSendSecretTo,
	decodeProfileChoice,
	encodeProfileChoice,
	llmProfileIdFromBytes,
	newLlmProfile,
	parseExtraBody,
	parseLlmProfiles,
	type LlmProfile,
} from "../src/core/llm";
import { activeLlmProfile, buildJobOptions, DEFAULT_SETTINGS, mergeSettings } from "../src/core/settings-model";

function profile(patch: Partial<LlmProfile> = {}): LlmProfile {
	return {
		...newLlmProfile("abc123"),
		name: "DeepSeek",
		baseUrl: " https://api.deepseek.com ",
		model: "deepseek-chat",
		secretId: "deepseek-key",
		...patch,
	};
}

describe("llm profiles", () => {
	it("解析设置里的配置列表，修正或丢弃不合法的条目", () => {
		const list = parseLlmProfiles([
			{ id: "a", name: "A", baseUrl: "https://a", model: "m", secretId: "k", qps: 8, extraBody: "{}" },
			{ id: "a", name: "重复 id" },
			{ id: "", name: "空 id" },
			{ name: "没有 id" },
			{ id: "b", name: 1, qps: 0 },
			"garbage",
		]);
		expect(list.map((p) => p.id)).toEqual(["a", "b"]);
		expect(list[0]?.qps).toBe(8);
		expect(list[1]?.name).toBe("新配置");
		expect(list[1]?.qps).toBe(4);
		expect(parseLlmProfiles("x")).toEqual([]);
	});

	it("mergeSettings 读取配置列表，不与默认值共用数组", () => {
		const s = mergeSettings({ llmProfiles: [{ id: "a" }], llmProfileId: "a" });
		expect(s.llmProfiles).toHaveLength(1);
		expect(activeLlmProfile(s)?.id).toBe("a");
		const fresh = mergeSettings({});
		fresh.llmProfiles.push(profile());
		expect(DEFAULT_SETTINGS.llmProfiles).toHaveLength(0);
		expect(activeLlmProfile({ ...s, llmProfileId: "gone" })).toBeNull();
		expect(activeLlmProfile({ ...s, llmProfileId: "" })).toBeNull();
	});

	it("id 由随机字节生成", () => {
		expect(llmProfileIdFromBytes(new Uint8Array([0, 15, 255]))).toBe("000fff");
	});

	it("额外请求参数必须是 JSON 对象", () => {
		expect(parseExtraBody("  ")).toBeNull();
		expect(parseExtraBody('{"thinking":{"type":"disabled"}}')).toEqual({ thinking: { type: "disabled" } });
		expect(() => parseExtraBody("{bad")).toThrow("不是合法的 JSON");
		expect(() => parseExtraBody("[1]")).toThrow("必须是 JSON 对象");
		expect(() => parseExtraBody('"x"')).toThrow("必须是 JSON 对象");
	});

	it("拼成任务参数", () => {
		const o = buildLlmJobOptions(
			profile({ temperature: " 0.3 ", timeout: "", extraBody: '{"thinking":{"type":"disabled"}}' }),
			" sk-1 ",
		);
		expect(o).toEqual({
			name: "DeepSeek",
			base_url: "https://api.deepseek.com",
			api_key: "sk-1",
			model: "deepseek-chat",
			qps: 4,
			temperature: "0.3",
			timeout: null,
			extra_body: { thinking: { type: "disabled" } },
		});
		const job = buildJobOptions({ ...DEFAULT_SETTINGS, profile: "server-one" }, {}, o);
		// 用插件配置时不再指定服务端 profile
		expect(job.profile).toBeNull();
		expect(job.llm).toBe(o);
	});

	it("关闭思考按服务商换成对应字段", () => {
		const off = (baseUrl: string, extraBody = "") =>
			buildLlmJobOptions(profile({ baseUrl, disableThinking: true, extraBody }), "k").extra_body;
		expect(off("https://api.deepseek.com")).toEqual({ thinking: { type: "disabled" } });
		expect(off("https://open.bigmodel.cn/api/paas/v4")).toEqual({ thinking: { type: "disabled" } });
		expect(off("https://dashscope.aliyuncs.com/compatible-mode/v1")).toEqual({ enable_thinking: false });
		expect(off("https://dashscope-intl.aliyuncs.com/v1")).toEqual({ thinking: { type: "disabled" } });
		// 手填的同名字段优先，其他字段合并
		expect(off("https://api.deepseek.com", '{"thinking":{"type":"enabled"},"top_p":0.9}')).toEqual({
			thinking: { type: "enabled" },
			top_p: 0.9,
		});
		// 不关闭思考、也没手填时不发送
		expect(buildLlmJobOptions(profile(), "k").extra_body).toBeNull();
	});

	it("旧设置里写在额外请求参数的关闭思考迁移成开关", () => {
		const [a, b, c, d] = parseLlmProfiles([
			{ id: "a", extraBody: '{ "thinking": { "type": "disabled" } }' },
			{ id: "b", extraBody: '{"enable_thinking": false}' },
			{ id: "c", extraBody: '{"thinking":{"type":"disabled"},"top_p":1}' },
			{ id: "d", disableThinking: false, extraBody: '{"thinking":{"type":"disabled"}}' },
		]);
		expect([a?.disableThinking, a?.extraBody]).toEqual([true, ""]);
		expect([b?.disableThinking, b?.extraBody]).toEqual([true, ""]);
		// 还有别的字段：不动
		expect(c?.disableThinking).toBe(false);
		expect(c?.extraBody).toContain("top_p");
		// 已经有开关的新设置：不迁移
		expect(d?.disableThinking).toBe(false);
	});

	it("配置有问题时给出说明", () => {
		expect(() => buildLlmJobOptions(profile({ baseUrl: "api.deepseek.com" }), "k")).toThrow("接口地址不合法");
		expect(() => buildLlmJobOptions(profile({ baseUrl: "ftp://x" }), "k")).toThrow("http://");
		expect(() => buildLlmJobOptions(profile({ model: " " }), "k")).toThrow("没有填写模型");
		expect(() => buildLlmJobOptions(profile(), "  ")).toThrow("没有设置 API key");
		expect(() => buildLlmJobOptions(profile({ qps: 0 }), "k")).toThrow("每秒请求数");
		expect(() => buildLlmJobOptions(profile({ temperature: "warm" }), "k")).toThrow("温度");
		expect(() => buildLlmJobOptions(profile({ extraBody: "[" }), "k")).toThrow("「DeepSeek」的额外请求参数");
	});

	it("只向本机或 https 地址发送密钥", () => {
		expect(canSendSecretTo("http://127.0.0.1:8891")).toBe(true);
		expect(canSendSecretTo("http://localhost:8891/")).toBe(true);
		expect(canSendSecretTo("https://babel.example.com/api")).toBe(true);
		expect(canSendSecretTo("http://192.168.1.5:8891")).toBe(false);
		expect(canSendSecretTo("not a url")).toBe(false);
	});

	it("下拉框取值往返", () => {
		for (const c of [
			{ kind: "server-default" },
			{ kind: "server", name: "deep:seek" },
			{ kind: "plugin", id: "abc" },
		] as const) {
			expect(decodeProfileChoice(encodeProfileChoice(c))).toEqual(c);
		}
	});
});
