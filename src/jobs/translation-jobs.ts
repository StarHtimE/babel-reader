import { Notice, type App, type TFile } from "obsidian";
import type { ServerClient } from "../api/client";
import { errorMessage } from "../core/errors";
import { sha256Hex } from "../core/hash";
import { buildLlmJobOptions, canSendSecretTo, type LlmJobOptions } from "../core/llm";
import { describePageRanges } from "../core/page";
import { PollCancelledError, pollJob } from "../core/poll";
import { formatProgress } from "../core/progress";
import { JobQueue, summaryText, type QueueItem } from "../core/queue";
import { activeLlmProfile, buildJobOptions, langOutOf, type BabelReaderSettings } from "../core/settings-model";
import { FEATURE_GLOSSARY, FEATURE_LLM_OPTIONS, type HealthInfo, type OutputKind } from "../core/types";
import type { GlossaryService } from "../glossary/glossary-service";
import type { ServerLauncher } from "../launcher/server-launcher";
import type { StaleChecker } from "../store/stale-checker";
import type { TranslationStore } from "../store/translation-store";

const POLL_INTERVAL_MS = 1000;

export type TranslationItem = QueueItem<TFile>;

/** 配置或服务的问题：后面的任务也会失败，整个队列停下 */
class QueueStopError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "QueueStopError";
	}
}

/** 任务在运行中被取消 */
class ItemCancelledError extends Error {
	constructor() {
		super("已取消");
		this.name = "ItemCancelledError";
	}
}

/**
 * 翻译队列：逐篇执行 上传 → 轮询进度 → 下载 → 写入译文目录。
 * 服务端也是串行执行，所以插件一次只提交一篇，其余在插件里排队。
 */
export class TranslationJobs {
	private queue = new JobQueue<TFile>();
	private jobIds = new Map<number, string>();
	/** 指定页翻译：任务 id → 页码范围（没有记录的翻译全部页） */
	private pagesById = new Map<number, string>();
	private pumping = false;
	private disposed = false;
	private timers = new Set<number>();
	private listeners = new Set<() => void>();

	constructor(
		private readonly app: App,
		private readonly client: ServerClient,
		private readonly store: TranslationStore,
		private readonly launcher: ServerLauncher,
		private readonly stale: StaleChecker,
		private readonly glossary: GlossaryService,
		private readonly getSettings: () => BabelReaderSettings,
		private readonly statusEl: HTMLElement,
	) {
		this.statusEl.addClass("babel-reader-status");
		this.hideStatus();
	}

	get isRunning(): boolean {
		return this.queue.busy;
	}

	items(): readonly TranslationItem[] {
		return this.queue.list();
	}

	isQueued(file: TFile): boolean {
		return this.queue.has(file);
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private emitChange(): void {
		for (const cb of this.listeners) cb();
	}

	/** 某个任务指定的页码范围；null 表示全部页 */
	pagesOf(item: TranslationItem): string | null {
		return this.pagesById.get(item.id) ?? null;
	}

	/** 翻译一篇（加入队列）；pages 为页码范围，null 表示全部页 */
	translate(file: TFile, pages: string | null = null): void {
		if (this.queue.has(file)) {
			new Notice(`「${file.basename}」已在翻译队列里`);
			return;
		}
		const ahead = this.queue.list().filter((i) => i.state === "waiting" || i.state === "running").length;
		this.enqueue([file], pages);
		if (ahead > 0) new Notice(`已加入翻译队列，前面还有 ${ahead} 篇`);
	}

	/** 加入一批；返回实际加入的数量（已在队列里的跳过） */
	enqueue(files: readonly TFile[], pages: string | null = null): number {
		if (!this.queue.busy) this.pagesById.clear();
		const added = this.queue.add(files);
		if (pages !== null) for (const item of added) this.pagesById.set(item.id, pages);
		if (added.length > 0) {
			this.emitChange();
			void this.pump();
		}
		return added.length;
	}

	cancelItem(item: TranslationItem): void {
		const running = this.queue.cancel(item);
		if (running) this.abortRunning(item);
		this.emitChange();
	}

	cancelAll(): void {
		const running = this.queue.cancelAll();
		if (running) this.abortRunning(running);
		this.emitChange();
	}

	/** 插件卸载时调用：停止轮询，并尽力通知服务端取消 */
	dispose(): void {
		this.disposed = true;
		const running = this.queue.cancelAll();
		if (running) this.abortRunning(running);
		for (const t of this.timers) window.clearTimeout(t);
		this.timers.clear();
		this.listeners.clear();
	}

	private abortRunning(item: TranslationItem): void {
		const jobId = this.jobIds.get(item.id);
		if (jobId) {
			this.client.cancelJob(jobId).catch((err) => console.warn("[babel-reader] 通知服务取消失败", err));
		}
	}

	private async pump(): Promise<void> {
		if (this.pumping) return;
		this.pumping = true;
		try {
			for (let item = this.queue.start(); item && !this.disposed; item = this.queue.start()) {
				this.emitChange();
				await this.runItem(item);
				this.emitChange();
			}
		} finally {
			this.pumping = false;
			this.hideStatus();
		}
		if (this.disposed) return;
		const summary = this.queue.summary();
		if (summary.total > 1) {
			const tail = summary.error > 0 ? "。点状态栏或运行命令「查看翻译队列」查看失败原因" : "";
			new Notice(summaryText(summary) + tail, summary.error > 0 ? 10000 : 5000);
		}
	}

	private async runItem(item: TranslationItem): Promise<void> {
		const file = item.payload;
		const single = this.queue.list().length === 1;
		try {
			const newTerms = await this.translateOne(item);
			const terms = newTerms ? `，${newTerms.count} 个新术语已加入「${newTerms.note}」的待审核` : "";
			this.queue.finish(item, "done", `完成${terms}`);
			if (single) {
				const pages = this.pagesOf(item);
				const range = pages === null ? "" : describePageRanges(pages);
				new Notice(`「${file.basename}」${range}翻译完成${terms}`, terms ? 8000 : 5000);
			}
		} catch (err) {
			if (err instanceof ItemCancelledError || err instanceof PollCancelledError || item.cancelRequested) {
				this.queue.finish(item, "cancelled", "已取消");
				if (single) new Notice(`已取消「${file.basename}」的翻译`);
				return;
			}
			const message = errorMessage(err);
			console.error(`[babel-reader] 翻译失败：${file.path}`, err);
			this.queue.finish(item, "error", "失败", message);
			if (err instanceof QueueStopError) {
				this.queue.cancelAll("因前一篇出错，队列已停止");
				new Notice(`翻译失败：${message}`, 10000);
			} else if (single) {
				new Notice(`翻译失败：${message}`, 10000);
			}
		} finally {
			this.jobIds.delete(item.id);
		}
	}

	/** 返回写回术语表的新术语（没有时为 null） */
	private async translateOne(item: TranslationItem): Promise<{ count: number; note: string } | null> {
		const file = item.payload;
		const settings = this.getSettings();
		const check = () => {
			if (item.cancelRequested || this.disposed) throw new ItemCancelledError();
		};
		// 排队期间文件可能被删除（改名不影响：TFile 对象会跟着更新路径）
		if (this.app.vault.getAbstractFileByPath(file.path) !== file) {
			throw new Error("文件已不存在");
		}

		let llm: LlmJobOptions | null;
		let engine: HealthInfo | null;
		try {
			// 先把大模型配置和密钥准备好：配置有问题时不必连服务
			llm = this.resolveLlm(settings);
			this.setDetail(item, "连接服务…");
			engine = await this.connect(item, settings);
		} catch (err) {
			if (item.cancelRequested) throw new ItemCancelledError();
			throw new QueueStopError(errorMessage(err));
		}
		if (!engine) throw new ItemCancelledError();
		check();
		// 旧版服务端会忽略 options.llm，悄悄改用 config.toml 的 profile，这里提前拦下
		if (llm && !engine.features.includes(FEATURE_LLM_OPTIONS)) {
			throw new QueueStopError(
				"翻译服务版本太旧，不支持插件里的大模型配置。请更新服务端（git pull 后 uv sync）并重启 Obsidian",
			);
		}
		const glossary = await this.glossary.forJob(file, langOutOf(settings));
		const options = buildJobOptions(settings, { pages: this.pagesOf(item), glossary_csv: glossary.csv }, llm);

		this.setDetail(item, "读取原文…");
		const stamp = { mtime: file.stat.mtime, size: file.stat.size };
		const data = await this.app.vault.readBinary(file);
		const sha256 = await sha256Hex(data);
		this.stale.remember(file, stamp, sha256);
		check();

		this.setDetail(item, "上传中…");
		const jobId = await this.client.createJob(data, options);
		this.jobIds.set(item.id, jobId);
		if (item.cancelRequested) {
			// 用户在上传期间点了取消：通知服务端
			await this.client.cancelJob(jobId).catch(() => undefined);
			throw new ItemCancelledError();
		}

		const final = await pollJob({
			fetchStatus: () => this.client.getJob(jobId),
			sleep: (ms) => this.sleep(ms),
			onUpdate: (s) => this.setDetail(item, formatProgress(s)),
			isCancelled: () => item.cancelRequested || this.disposed,
			intervalMs: POLL_INTERVAL_MS,
		});
		if (final.state === "cancelled") throw new ItemCancelledError();
		if (final.state !== "done") throw new Error(final.error ?? "服务端未给出原因");

		this.setDetail(item, "下载译文…");
		const files: Partial<Record<OutputKind, ArrayBuffer>> = {};
		const available = final.outputs ?? options.outputs;
		for (const kind of options.outputs) {
			if (!available.includes(kind)) continue;
			files[kind] = await this.client.downloadOutput(jobId, kind);
			check();
		}
		if (!files.mono && !files.dual) throw new Error("服务没有返回任何译文");

		this.setDetail(item, "写入仓库…");
		await this.store.save({
			source: file,
			sourceSha256: sha256,
			langIn: options.lang_in,
			langOut: options.lang_out,
			files,
			// manifest 只记配置名，不记密钥
			profile: llm?.name ?? options.profile,
			pages: options.pages,
			glossary: glossary.notes.length > 0 ? glossary.notes.join(", ") : null,
			engine,
		});

		// 自动抽取的术语：追加到术语表的「待审核」小节；失败不影响这次翻译
		const path = glossary.writeBackPath;
		if (!options.auto_extract_glossary || !settings.writeBackGlossary || !path) return null;
		if (!engine.features.includes(FEATURE_GLOSSARY)) return null;
		if (!final.extras?.includes("glossary")) return null;
		try {
			this.setDetail(item, "整理术语…");
			const count = await this.glossary.writeBack(path, await this.client.downloadGlossary(jobId), file);
			const note = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
			return count > 0 ? { count, note } : null;
		} catch (err) {
			console.warn("[babel-reader] 写回自动抽取的术语失败", err);
			return null;
		}
	}

	/**
	 * 选用了插件里的大模型配置时，从 Obsidian 的密钥存储取出 API key 并拼成任务参数；
	 * 用服务端 profile 时返回 null。
	 */
	private resolveLlm(settings: BabelReaderSettings): LlmJobOptions | null {
		if (settings.llmProfileId === "") return null;
		const profile = activeLlmProfile(settings);
		if (!profile) throw new Error("选用的大模型配置已被删除，请在设置里重新选择");
		if (!canSendSecretTo(settings.serverUrl)) {
			throw new Error("服务地址既不是本机也不是 https，插件不会通过明文连接发送 API key");
		}
		const id = profile.secretId.trim();
		const apiKey = id === "" ? null : this.app.secretStorage.getSecret(id);
		if (apiKey === null || apiKey.trim() === "") {
			throw new Error(`大模型配置「${profile.name}」没有设置 API key，请在设置里选择或新建密钥`);
		}
		return buildLlmJobOptions(profile, apiKey);
	}

	/** 连接服务（必要时自动启动）；被取消时返回 null */
	private connect(item: TranslationItem, settings: BabelReaderSettings): Promise<HealthInfo | null> {
		return this.launcher.connect(
			{
				serverUrl: settings.serverUrl,
				serverDir: settings.serverDir,
				autoStart: settings.autoStartServer,
			},
			() => item.cancelRequested || this.disposed,
			() => this.setDetail(item, "启动翻译服务…"),
		);
	}

	private setDetail(item: TranslationItem, text: string): void {
		item.detail = text;
		this.showStatus(item);
		this.emitChange();
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const t = window.setTimeout(() => {
				this.timers.delete(t);
				resolve();
			}, ms);
			this.timers.add(t);
		});
	}

	private showStatus(item: TranslationItem): void {
		if (this.disposed) return;
		const { index, total } = this.queue.position(item);
		const counter = total > 1 ? ` ${index}/${total}` : "";
		this.statusEl.setText(`翻译${counter} ${item.payload.basename}：${item.detail}`);
		this.statusEl.setAttr("aria-label", "点击查看翻译队列");
		this.statusEl.removeClass("babel-reader-hidden");
	}

	private hideStatus(): void {
		this.statusEl.empty();
		this.statusEl.addClass("babel-reader-hidden");
	}
}
