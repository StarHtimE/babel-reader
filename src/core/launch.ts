import { ApiError } from "./errors";

/** 插件自动启动服务时的监听地址；只有本机地址才会自动启动 */
export interface LaunchTarget {
	host: string;
	port: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * 从服务地址推出本机服务的监听地址。
 * 不是 http、不是本机、或带路径前缀（多半是反向代理）时返回 null：这些情况不由插件启动。
 */
export function localLaunchTarget(serverUrl: string): LaunchTarget | null {
	let url: URL;
	try {
		url = new URL(serverUrl.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:") return null;
	if (url.pathname !== "/" && url.pathname !== "") return null;
	// IPv6 地址在 URL 里带方括号
	const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
	if (!LOOPBACK_HOSTS.has(host)) return null;
	const port = url.port === "" ? 80 : Number(url.port);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
	return { host, port };
}

/** 用户粘贴的路径：去掉首尾空白和成对的引号（Windows「复制为路径」会带引号） */
export function cleanUserPath(raw: string): string {
	let p = raw.trim();
	if (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) {
		p = p.slice(1, -1).trim();
	}
	return p;
}

/** 服务程序相对服务目录的路径段（uv sync 生成的虚拟环境里） */
export function serverExecutableSegments(isWindows: boolean): string[] {
	return isWindows
		? [".venv", "Scripts", "babel-reader-server.exe"]
		: [".venv", "bin", "babel-reader-server"];
}

export const SERVER_CONFIG_FILE = "config.toml";
export const SERVER_LOG_FILE = "server.log";

/** serve 子命令的参数；--log-file 是全局参数，必须放在子命令之前 */
export function serveArgs(target: LaunchTarget, logFile: string): string[] {
	return [
		"--log-file",
		logFile,
		"serve",
		"--config",
		SERVER_CONFIG_FILE,
		"--host",
		target.host,
		"--port",
		String(target.port),
	];
}

/** 只保留最后若干行输出，用于启动失败时的提示 */
export class OutputTail {
	private lines: string[] = [];
	private partial = "";

	constructor(private readonly maxLines = 20) {}

	push(text: string): void {
		const parts = (this.partial + text).split(/\r?\n/);
		this.partial = parts.pop() ?? "";
		for (const line of parts) {
			if (line.trim() === "") continue;
			this.lines.push(line);
		}
		if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
	}

	/** 最后 n 行（含尚未换行的部分） */
	last(n: number): string[] {
		const all = this.partial.trim() === "" ? this.lines : [...this.lines, this.partial];
		return all.slice(-n);
	}
}

/** 连不上服务（网络层失败）；HTTP 错误说明服务在运行，不属于这一类 */
export function isConnectionError(err: unknown): boolean {
	return err instanceof ApiError && err.status === 0;
}

export class LaunchTimeoutError extends Error {
	constructor(seconds: number) {
		super(`翻译服务在 ${seconds} 秒内没有就绪`);
		this.name = "LaunchTimeoutError";
	}
}

/**
 * 等服务就绪：反复调用 probe，直到成功。
 * - 连接失败：继续等
 * - 其他错误（如令牌不对）：服务已经起来了，原样抛出
 * - 进程退出：抛出 exited() 给出的原因
 * - 被取消：返回 null
 */
export async function waitUntilReady<T>(opts: {
	probe: () => Promise<T>;
	/** 进程已退出时返回描述原因的错误，否则返回 null */
	exited: () => Error | null;
	isCancelled: () => boolean;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	timeoutMs: number;
	intervalMs: number;
}): Promise<T | null> {
	const deadline = opts.now() + opts.timeoutMs;
	for (;;) {
		if (opts.isCancelled()) return null;
		const exitError = opts.exited();
		if (exitError) throw exitError;
		try {
			return await opts.probe();
		} catch (err) {
			if (!isConnectionError(err)) throw err;
		}
		if (opts.now() >= deadline) throw new LaunchTimeoutError(Math.round(opts.timeoutMs / 1000));
		await opts.sleep(opts.intervalMs);
	}
}
