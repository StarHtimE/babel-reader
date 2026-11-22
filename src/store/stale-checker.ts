import { TFile, type App, type TAbstractFile } from "obsidian";
import { sha256Hex } from "../core/hash";
import { freshness, HashCache, type Freshness } from "../core/stale";
import type { TranslationEntry } from "../core/translation-index";
import type { TranslationStore } from "./translation-store";

/**
 * 判断译文是否过期（原文内容在翻译后变了）。
 * 只在需要时计算原文哈希：打开有译文的 PDF 时、批量翻译前；不在启动时扫描全部 PDF。
 * 结果按 修改时间 + 大小 缓存，文件没变就不再读取。
 */
export class StaleChecker {
	private cache = new HashCache();
	private inflight = new Map<string, Promise<string | null>>();
	/** 读取失败的文件：记下当时的 修改时间 + 大小，文件变了之前不再重试 */
	private failed = new HashCache();
	private listeners = new Set<() => void>();

	constructor(
		private readonly app: App,
		private readonly store: TranslationStore,
	) {}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private emitChange(): void {
		for (const cb of this.listeners) cb();
	}

	private sourceFile(entry: TranslationEntry): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(entry.manifest.source.path);
		return f instanceof TFile ? f : null;
	}

	/**
	 * 立即返回已知的结果；还不知道时在后台计算，算完通过 onChange 通知（供界面刷新用）。
	 * 原文不存在时返回 "unknown"。
	 */
	check(entry: TranslationEntry): Freshness {
		const file = this.sourceFile(entry);
		if (!file) return "unknown";
		const sha = this.cache.get(file.path, file.stat);
		if (sha === undefined && this.failed.get(file.path, file.stat) === undefined) {
			void this.hash(file).then((h) => {
				if (h !== null) this.emitChange();
			});
		}
		return freshness(entry.manifest.source.sha256, sha);
	}

	/** 等算出结果再返回（批量翻译前用） */
	async freshnessOf(entry: TranslationEntry): Promise<Freshness> {
		const file = this.sourceFile(entry);
		if (!file) return "unknown";
		const sha = await this.hash(file);
		return freshness(entry.manifest.source.sha256, sha ?? undefined);
	}

	/** 翻译时已经算过哈希：记下来，省得再读一遍 */
	remember(file: TFile, stamp: { mtime: number; size: number }, sha256: string): void {
		this.cache.set(file.path, stamp, sha256);
	}

	private hash(file: TFile): Promise<string | null> {
		const stamp = { mtime: file.stat.mtime, size: file.stat.size };
		const cached = this.cache.get(file.path, stamp);
		if (cached !== undefined) return Promise.resolve(cached);
		const key = `${file.path}\n${stamp.mtime}\n${stamp.size}`;
		let p = this.inflight.get(key);
		if (!p) {
			p = (async () => {
				try {
					const sha = await sha256Hex(await this.app.vault.readBinary(file));
					this.cache.set(file.path, stamp, sha);
					return sha;
				} catch (err) {
					console.warn(`[babel-reader] 计算原文哈希失败：${file.path}`, err);
					this.failed.set(file.path, stamp, "");
					return null;
				} finally {
					this.inflight.delete(key);
				}
			})();
			this.inflight.set(key, p);
		}
		return p;
	}

	// ---- 仓库事件 ----------------------------------------------------------

	/** 原文被修改：让打开着的视图重新判断 */
	handleModify(file: TAbstractFile): void {
		if (file instanceof TFile && this.store.index.entriesForSource(file.path).length > 0) {
			this.emitChange();
		}
	}

	handleRename(file: TAbstractFile, oldPath: string): void {
		this.cache.rename(oldPath, file.path);
		this.failed.rename(oldPath, file.path);
	}

	handleDelete(file: TAbstractFile): void {
		this.cache.delete(file.path);
		this.failed.delete(file.path);
	}
}
