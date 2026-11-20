import { Notice, type App, type TFile } from "obsidian";
import type { ServerClient } from "../api/client";
import { errorMessage } from "../core/errors";
import { sha256Hex } from "../core/hash";
import { PollCancelledError, pollJob } from "../core/poll";
import { formatProgress } from "../core/progress";
import { buildJobOptions, type BabelReaderSettings } from "../core/settings-model";
import type { JobStatus, OutputKind } from "../core/types";
import type { TranslationStore } from "../store/translation-store";
import { confirmDialog } from "../view/confirm-modal";

const POLL_INTERVAL_MS = 1000;

interface ActiveJob {
	file: TFile;
	jobId: string | null;
	cancelled: boolean;
}

/**
 * 单篇翻译任务：上传 → 轮询进度 → 下载 → 写入译文目录。
 * v0.1 同一时间只跑一个任务；批量与队列在 v0.2。
 */
export class TranslationJobs {
	private active: ActiveJob | null = null;
	private timers = new Set<number>();

	constructor(
		private readonly app: App,
		private readonly client: ServerClient,
		private readonly store: TranslationStore,
		private readonly getSettings: () => BabelReaderSettings,
		private readonly statusEl: HTMLElement,
	) {
		this.statusEl.addClass("babel-reader-status");
		this.hideStatus();
	}

	get isRunning(): boolean {
		return this.active !== null;
	}

	/** 状态栏点击 */
	async onStatusClick(): Promise<void> {
		if (!this.active) return;
		const ok = await confirmDialog(this.app, {
			title: "取消翻译",
			message: `要取消「${this.active.file.basename}」的翻译吗？`,
			confirmText: "取消翻译",
			cancelText: "继续翻译",
		});
		if (ok) await this.cancel();
	}

	async translate(file: TFile): Promise<void> {
		if (this.active) {
			new Notice(`正在翻译「${this.active.file.basename}」，请等它完成或先取消`);
			return;
		}
		const job: ActiveJob = { file, jobId: null, cancelled: false };
		this.active = job;
		const settings = this.getSettings();
		const options = buildJobOptions(settings);

		try {
			this.showStatus("连接服务…");
			const engine = await this.client.health();
			if (job.cancelled) return;

			this.showStatus("读取原文…");
			const data = await this.app.vault.readBinary(file);
			const sha256 = await sha256Hex(data);
			if (job.cancelled) return;

			this.showStatus("上传中…");
			job.jobId = await this.client.createJob(data, options);
			if (job.cancelled) {
				// 用户在上传期间点了取消：通知服务端
				await this.client.cancelJob(job.jobId).catch(() => undefined);
				return;
			}

			const jobId = job.jobId;
			const final = await pollJob({
				fetchStatus: () => this.client.getJob(jobId),
				sleep: (ms) => this.sleep(ms),
				onUpdate: (s) => this.showStatus(formatProgress(s)),
				isCancelled: () => job.cancelled,
				intervalMs: POLL_INTERVAL_MS,
			});
			if (final.state !== "done") {
				this.reportUnfinished(file, final);
				return;
			}

			this.showStatus("下载译文…");
			const files: Partial<Record<OutputKind, ArrayBuffer>> = {};
			const available = final.outputs ?? options.outputs;
			for (const kind of options.outputs) {
				if (!available.includes(kind)) continue;
				files[kind] = await this.client.downloadOutput(jobId, kind);
				if (job.cancelled) return;
			}
			if (!files.mono && !files.dual) throw new Error("服务没有返回任何译文");

			this.showStatus("写入仓库…");
			await this.store.save({
				source: file,
				sourceSha256: sha256,
				langIn: options.lang_in,
				langOut: options.lang_out,
				files,
				profile: options.profile,
				pages: options.pages,
				engine,
			});
			new Notice(`「${file.basename}」翻译完成`);
		} catch (err) {
			if (err instanceof PollCancelledError || job.cancelled) return;
			console.error("[babel-reader] 翻译失败", err);
			new Notice(`翻译失败：${errorMessage(err)}`, 10000);
		} finally {
			if (this.active === job) this.active = null;
			this.hideStatus();
		}
	}

	async cancel(): Promise<void> {
		const job = this.active;
		if (!job || job.cancelled) return;
		job.cancelled = true;
		this.active = null;
		this.hideStatus();
		if (job.jobId) {
			try {
				await this.client.cancelJob(job.jobId);
			} catch (err) {
				console.warn("[babel-reader] 通知服务取消失败", err);
			}
		}
		new Notice(`已取消「${job.file.basename}」的翻译`);
	}

	/** 插件卸载时调用：停止轮询，并尽力通知服务端取消 */
	dispose(): void {
		for (const t of this.timers) window.clearTimeout(t);
		this.timers.clear();
		const job = this.active;
		if (job) {
			job.cancelled = true;
			this.active = null;
			if (job.jobId) void this.client.cancelJob(job.jobId).catch(() => undefined);
		}
	}

	private reportUnfinished(file: TFile, status: JobStatus): void {
		if (status.state === "cancelled") {
			new Notice(`「${file.basename}」的翻译已在服务端取消`);
		} else {
			new Notice(`翻译失败：${status.error ?? "服务端未给出原因"}`, 10000);
		}
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

	private showStatus(text: string): void {
		const name = this.active?.file.basename ?? "";
		this.statusEl.setText(`翻译 ${name}：${text}`);
		this.statusEl.setAttr("aria-label", "点击取消翻译");
		this.statusEl.removeClass("babel-reader-hidden");
	}

	private hideStatus(): void {
		this.statusEl.empty();
		this.statusEl.addClass("babel-reader-hidden");
	}
}
