import { Platform } from "obsidian";
import type { ServerClient } from "../api/client";
import { errorMessage } from "../core/errors";
import {
	cleanUserPath,
	isConnectionError,
	launchFailureHint,
	localLaunchTarget,
	OutputTail,
	SERVER_CONFIG_FILE,
	SERVER_LOG_FILE,
	serveArgs,
	serverExecutableSegments,
	waitUntilReady,
} from "../core/launch";
import type { HealthInfo } from "../core/types";

/*
 * 在本机启动用户已经装好的翻译服务（只在桌面端）。
 *
 * - 只运行 <服务目录>/.venv 里现成的程序，不调用 uv / pip，不安装或更新任何东西
 *   （Obsidian 开发者政策禁止插件安装或更新自身及其依赖）
 * - Node 模块只在 Platform.isDesktopApp 为真时按需加载，移动端不会碰到
 * - 只结束自己启动的进程；用户手动启动的服务不受影响
 */

const STARTUP_TIMEOUT_MS = 90_000;
const PROBE_INTERVAL_MS = 500;

// ---- 用到的 Node API 的最小类型（tsconfig 不引入 @types/node，避免 Node 全局类型混进插件代码）----

interface DataStream {
	on(event: "data", cb: (chunk: Uint8Array) => void): void;
}

interface ChildProcess {
	readonly pid?: number;
	readonly stdout: DataStream | null;
	readonly stderr: DataStream | null;
	on(event: "exit", cb: (code: number | null, signal: string | null) => void): void;
	on(event: "error", cb: (err: Error) => void): void;
	kill(): boolean;
}

interface ChildProcessModule {
	spawn(
		command: string,
		args: string[],
		options: {
			cwd: string;
			windowsHide: boolean;
			detached: boolean;
			stdio: ["ignore", "pipe", "pipe"];
		},
	): ChildProcess;
	spawnSync(command: string, args: string[], options: { windowsHide: boolean; timeout: number }): unknown;
}

interface FsModule {
	existsSync(path: string): boolean;
}

interface PathModule {
	join(...segments: string[]): string;
	isAbsolute(path: string): boolean;
}

interface NodeModules {
	childProcess: ChildProcessModule;
	fs: FsModule;
	path: PathModule;
}

interface DesktopWindow {
	require(id: string): unknown;
}

function loadNodeModules(): NodeModules {
	if (!Platform.isDesktopApp) throw new Error("只有桌面端可以自动启动翻译服务");
	return {
		childProcess: (window as unknown as DesktopWindow).require("child_process") as ChildProcessModule,
		fs: (window as unknown as DesktopWindow).require("fs") as FsModule,
		path: (window as unknown as DesktopWindow).require("path") as PathModule,
	};
}

/** 服务目录里要用到的路径 */
interface ServerPaths {
	dir: string;
	executable: string;
	config: string;
	log: string;
}

interface RunningServer {
	process: ChildProcess;
	paths: ServerPaths;
	tail: OutputTail;
	/** 进程退出后才有值 */
	exit: { code: number | null; signal: string | null; error?: Error } | null;
}

export class ServerLauncher {
	private running: RunningServer | null = null;

	constructor(private readonly client: ServerClient) {}

	/** 当前平台能否自动启动（移动端不能） */
	get supported(): boolean {
		return Platform.isDesktopApp;
	}

	/**
	 * 检查服务目录是否可用，返回问题列表（空列表表示没问题）。
	 * 只检查文件是否存在，不读取内容。
	 */
	checkServerDir(rawDir: string): string[] {
		const result = this.resolvePaths(rawDir);
		return "problems" in result ? result.problems : [];
	}

	/**
	 * 连接服务；连不上本机服务且开启了自动启动时，先启动再连。
	 * 返回 /health 的结果；被取消时返回 null。翻译和「测试连接」共用。
	 */
	async connect(
		opts: { serverUrl: string; serverDir: string; autoStart: boolean },
		isCancelled: () => boolean,
		onStarting: () => void,
	): Promise<HealthInfo | null> {
		try {
			return await this.client.health();
		} catch (err) {
			if (!isConnectionError(err) || !opts.autoStart || !this.supported) throw err;
			// 服务地址不是本机时，原样报告连接失败
			if (localLaunchTarget(opts.serverUrl) === null) throw err;
		}
		onStarting();
		return this.startAndWait(opts, isCancelled);
	}

	/**
	 * 启动服务并等它就绪，返回 /health 的结果；被取消时返回 null。
	 * 已经有自己启动的进程在运行时不会再启动第二个，只是继续等它。
	 */
	async startAndWait(
		opts: { serverUrl: string; serverDir: string },
		isCancelled: () => boolean,
	): Promise<HealthInfo | null> {
		const target = localLaunchTarget(opts.serverUrl);
		if (!target) {
			throw new Error("服务地址不是本机地址（如 http://127.0.0.1:8891），插件不会自动启动服务");
		}
		if (cleanUserPath(opts.serverDir) === "") {
			throw new Error("无法连接翻译服务。在设置里填写「服务目录」后插件可以自动启动服务，也可以手动启动");
		}

		let server = this.running;
		if (!server || server.exit) {
			const resolved = this.resolvePaths(opts.serverDir);
			if ("problems" in resolved) throw new Error(`无法自动启动翻译服务：${resolved.problems.join("；")}`);
			server = this.spawn(resolved, serveArgs(target, resolved.log));
		}
		const current = server;

		return waitUntilReady({
			probe: () => this.client.health(),
			exited: () => (current.exit ? new Error(this.describeExit(current)) : null),
			isCancelled,
			sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
			now: () => Date.now(),
			timeoutMs: STARTUP_TIMEOUT_MS,
			intervalMs: PROBE_INTERVAL_MS,
		});
	}

	/** 结束自己启动的服务（连同它的翻译子进程）；可重复调用 */
	stop(): void {
		const server = this.running;
		this.running = null;
		if (!server || server.exit || server.process.pid === undefined) return;
		const pid = server.process.pid;
		try {
			const { childProcess } = loadNodeModules();
			// 服务会再起子进程做翻译，要整棵进程树一起结束
			if (Platform.isWin) {
				childProcess.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
					windowsHide: true,
					timeout: 5000,
				});
			} else {
				// 启动时用了 detached，服务是自己进程组的组长，负 pid 表示整组
				childProcess.spawnSync("kill", ["-TERM", "--", `-${pid}`], { windowsHide: true, timeout: 5000 });
			}
		} catch (err) {
			console.warn("[babel-reader] 结束翻译服务失败，改为只结束主进程", errorMessage(err));
			server.process.kill();
		}
	}

	private resolvePaths(rawDir: string): ServerPaths | { problems: string[] } {
		const dir = cleanUserPath(rawDir);
		if (dir === "") return { problems: ["没有填写服务目录"] };
		const { fs, path } = loadNodeModules();
		if (!path.isAbsolute(dir)) return { problems: ["服务目录必须是完整路径"] };
		if (!fs.existsSync(dir)) return { problems: [`服务目录「${dir}」不存在`] };

		const paths: ServerPaths = {
			dir,
			executable: path.join(dir, ...serverExecutableSegments(Platform.isWin)),
			config: path.join(dir, SERVER_CONFIG_FILE),
			log: path.join(dir, SERVER_LOG_FILE),
		};
		const problems: string[] = [];
		if (!fs.existsSync(paths.executable)) {
			problems.push(`找不到服务程序「${paths.executable}」，请先在服务目录里运行 uv sync`);
		}
		if (!fs.existsSync(paths.config)) {
			problems.push(`服务目录里没有 ${SERVER_CONFIG_FILE}，请参照 config.example.toml 创建`);
		}
		return problems.length > 0 ? { problems } : paths;
	}

	private spawn(paths: ServerPaths, args: string[]): RunningServer {
		const { childProcess } = loadNodeModules();
		const proc = childProcess.spawn(paths.executable, args, {
			cwd: paths.dir,
			windowsHide: true,
			detached: !Platform.isWin,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const server: RunningServer = { process: proc, paths, tail: new OutputTail(), exit: null };
		// 必须持续读走输出，否则管道写满后服务会卡住
		for (const stream of [proc.stdout, proc.stderr]) {
			// 每个流各用一个解码器，免得多字节字符在两个流之间被拆坏
			const decoder = new TextDecoder("utf-8");
			stream?.on("data", (chunk) => server.tail.push(decoder.decode(chunk, { stream: true })));
		}
		proc.on("error", (error) => {
			server.exit = { code: null, signal: null, error };
		});
		proc.on("exit", (code, signal) => {
			server.exit = { ...server.exit, code, signal };
			if (this.running === server) this.running = null;
		});
		this.running = server;
		return server;
	}

	private describeExit(server: RunningServer): string {
		const exit = server.exit;
		const reason = exit?.error
			? errorMessage(exit.error)
			: `进程已退出（退出码 ${exit?.code ?? "?"}）`;
		// 提示里只放最后 3 行，完整的输出打到开发者工具的 Console
		const all = server.tail.last(20);
		if (all.length > 0) console.error(`[babel-reader] 翻译服务的输出：\n${all.join("\n")}`);
		const lines = all.slice(-3);
		const output = lines.length > 0 ? `：${lines.join(" / ")}` : "";
		const hint = launchFailureHint(all);
		const advice = hint ? `。${hint}` : `。完整日志见 ${server.paths.log}`;
		return `翻译服务启动失败，${reason}${output}${advice}`;
	}
}
