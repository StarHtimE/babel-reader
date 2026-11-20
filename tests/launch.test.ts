import { describe, expect, it } from "vitest";
import { ApiError } from "../src/core/errors";
import {
	cleanUserPath,
	isConnectionError,
	launchFailureHint,
	LaunchTimeoutError,
	localLaunchTarget,
	OutputTail,
	serveArgs,
	serverExecutableSegments,
	waitUntilReady,
} from "../src/core/launch";

describe("localLaunchTarget", () => {
	it("只对本机 http 地址返回监听地址", () => {
		expect(localLaunchTarget("http://127.0.0.1:8891")).toEqual({ host: "127.0.0.1", port: 8891 });
		expect(localLaunchTarget(" http://localhost:9000/ ")).toEqual({ host: "localhost", port: 9000 });
		expect(localLaunchTarget("http://[::1]:8891")).toEqual({ host: "::1", port: 8891 });
		expect(localLaunchTarget("http://127.0.0.1")).toEqual({ host: "127.0.0.1", port: 80 });
	});

	it("远程、https、带路径或不合法的地址不自动启动", () => {
		expect(localLaunchTarget("http://192.168.1.5:8891")).toBeNull();
		expect(localLaunchTarget("https://127.0.0.1:8891")).toBeNull();
		expect(localLaunchTarget("http://127.0.0.1:8891/babel")).toBeNull();
		expect(localLaunchTarget("not a url")).toBeNull();
		expect(localLaunchTarget("")).toBeNull();
	});
});

describe("launch helpers", () => {
	it("清理用户粘贴的路径", () => {
		expect(cleanUserPath('  "D:\\a b\\server"  ')).toBe("D:\\a b\\server");
		expect(cleanUserPath("'/opt/server'")).toBe("/opt/server");
		expect(cleanUserPath('D:\\x"')).toBe('D:\\x"');
		expect(cleanUserPath("")).toBe("");
	});

	it("服务程序路径与参数", () => {
		expect(serverExecutableSegments(true)).toEqual([".venv", "Scripts", "babel-reader-server.exe"]);
		expect(serverExecutableSegments(false)).toEqual([".venv", "bin", "babel-reader-server"]);
		const args = serveArgs({ host: "127.0.0.1", port: 8891 }, "D:\\s\\server.log");
		// --log-file 必须在子命令之前
		expect(args.indexOf("--log-file")).toBeLessThan(args.indexOf("serve"));
		expect(args).toContain("8891");
	});

	it("只保留最后几行输出", () => {
		const tail = new OutputTail(3);
		tail.push("a\r\nb\n\nc\nd");
		tail.push("e\nf");
		// 最多 3 个完整行，再加上尚未换行的 "f"
		expect(tail.last(10)).toEqual(["b", "c", "de", "f"]);
		expect(tail.last(2)).toEqual(["de", "f"]);
	});

	it("认出失效的虚拟环境", () => {
		expect(launchFailureHint(["error: uv trampoline failed to canonicalize script path"])).toContain("uv sync");
		expect(launchFailureHint(["No Python at '\"C:\\x\\python.exe'"])).toContain(".venv");
		expect(launchFailureHint(["OSError: [Errno 10048] address already in use"])).toBeNull();
		expect(launchFailureHint([])).toBeNull();
	});

	it("区分连接失败和 HTTP 错误", () => {
		expect(isConnectionError(new ApiError(0, "x"))).toBe(true);
		expect(isConnectionError(new ApiError(401, "x"))).toBe(false);
		expect(isConnectionError(new Error("x"))).toBe(false);
	});
});

describe("waitUntilReady", () => {
	function clock() {
		let t = 0;
		return { now: () => t, sleep: (ms: number) => ((t += ms), Promise.resolve()) };
	}

	it("连接失败时重试，直到成功", async () => {
		const c = clock();
		let calls = 0;
		const result = await waitUntilReady({
			probe: () => (++calls < 3 ? Promise.reject(new ApiError(0, "refused")) : Promise.resolve("ok")),
			exited: () => null,
			isCancelled: () => false,
			timeoutMs: 10_000,
			intervalMs: 500,
			...c,
		});
		expect(result).toBe("ok");
		expect(calls).toBe(3);
	});

	it("HTTP 错误直接抛出", async () => {
		const c = clock();
		await expect(
			waitUntilReady({
				probe: () => Promise.reject(new ApiError(401, "bad token")),
				exited: () => null,
				isCancelled: () => false,
				timeoutMs: 10_000,
				intervalMs: 500,
				...c,
			}),
		).rejects.toThrow("bad token");
	});

	it("进程退出、超时、取消", async () => {
		const refused = () => Promise.reject(new ApiError(0, "refused"));
		await expect(
			waitUntilReady({
				probe: refused,
				exited: () => new Error("exit 2"),
				isCancelled: () => false,
				timeoutMs: 10_000,
				intervalMs: 500,
				...clock(),
			}),
		).rejects.toThrow("exit 2");

		await expect(
			waitUntilReady({
				probe: refused,
				exited: () => null,
				isCancelled: () => false,
				timeoutMs: 2_000,
				intervalMs: 500,
				...clock(),
			}),
		).rejects.toBeInstanceOf(LaunchTimeoutError);

		let n = 0;
		const result = await waitUntilReady({
			probe: refused,
			exited: () => null,
			isCancelled: () => ++n > 2,
			timeoutMs: 10_000,
			intervalMs: 500,
			...clock(),
		});
		expect(result).toBeNull();
	});
});
