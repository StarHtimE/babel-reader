import type { TranslationManifest } from "./manifest";
import { joinVaultPath, parentPath } from "./naming";
import type { OutputKind, ViewMode } from "./types";
import { OUTPUT_KINDS } from "./types";

export interface TranslationEntry {
	/** manifest.json 在仓库里的路径 */
	manifestPath: string;
	manifest: TranslationManifest;
}

export interface ResolvedTranslation {
	entry: TranslationEntry;
	/** 被查询的文件在这组译文里扮演的角色 */
	mode: ViewMode;
}

export function entryDir(entry: TranslationEntry): string {
	return parentPath(entry.manifestPath);
}

export function outputPath(entry: TranslationEntry, kind: OutputKind): string | null {
	const name = entry.manifest.outputs[kind];
	return name === undefined ? null : joinVaultPath(entryDir(entry), name);
}

/** 返回某个模式对应的仓库路径：original 为原文，其余为译文 */
export function pathForMode(entry: TranslationEntry, mode: ViewMode): string | null {
	return mode === "original" ? entry.manifest.source.path : outputPath(entry, mode);
}

/**
 * 原文路径 ⇄ 译文的双向索引（纯数据结构，不依赖 Obsidian）。
 * 同一原文可能有多组译文（不同目标语言），查询时优先匹配目标语言，其次取最新的一组。
 */
export class TranslationIndex {
	private byManifest = new Map<string, TranslationEntry>();
	private bySource = new Map<string, Set<string>>();
	private byOutput = new Map<string, { manifestPath: string; kind: OutputKind }>();

	get size(): number {
		return this.byManifest.size;
	}

	clear(): void {
		this.byManifest.clear();
		this.bySource.clear();
		this.byOutput.clear();
	}

	set(entry: TranslationEntry): void {
		this.remove(entry.manifestPath);
		this.byManifest.set(entry.manifestPath, entry);
		const src = entry.manifest.source.path;
		let set = this.bySource.get(src);
		if (!set) {
			set = new Set();
			this.bySource.set(src, set);
		}
		set.add(entry.manifestPath);
		for (const kind of OUTPUT_KINDS) {
			const p = outputPath(entry, kind);
			if (p !== null) this.byOutput.set(p, { manifestPath: entry.manifestPath, kind });
		}
	}

	remove(manifestPath: string): void {
		const old = this.byManifest.get(manifestPath);
		if (!old) return;
		this.byManifest.delete(manifestPath);
		const set = this.bySource.get(old.manifest.source.path);
		if (set) {
			set.delete(manifestPath);
			if (set.size === 0) this.bySource.delete(old.manifest.source.path);
		}
		for (const [p, ref] of this.byOutput) {
			if (ref.manifestPath === manifestPath) this.byOutput.delete(p);
		}
	}

	/** 移除 manifest 路径等于 path 或位于 path 目录之下的条目，返回移除的数量 */
	removeUnder(path: string): number {
		const prefix = `${path}/`;
		const hits = [...this.byManifest.keys()].filter((mp) => mp === path || mp.startsWith(prefix));
		for (const mp of hits) this.remove(mp);
		return hits.length;
	}

	/** path 是否与某组译文有关：manifest、译文文件，或包含它们的目录 */
	touches(path: string): boolean {
		const prefix = `${path}/`;
		for (const mp of this.byManifest.keys()) {
			if (mp === path || mp.startsWith(prefix)) return true;
		}
		for (const op of this.byOutput.keys()) {
			if (op === path || op.startsWith(prefix)) return true;
		}
		return false;
	}

	get(manifestPath: string): TranslationEntry | undefined {
		return this.byManifest.get(manifestPath);
	}

	entriesForSource(sourcePath: string): TranslationEntry[] {
		const set = this.bySource.get(sourcePath);
		if (!set) return [];
		const out: TranslationEntry[] = [];
		for (const mp of set) {
			const e = this.byManifest.get(mp);
			if (e) out.push(e);
		}
		return out;
	}

	/** 原文路径等于 path，或位于 path 目录之下的所有条目（用于原文或其所在文件夹被重命名 / 删除） */
	entriesUnderSource(path: string): TranslationEntry[] {
		const prefix = `${path}/`;
		const out: TranslationEntry[] = [];
		for (const e of this.byManifest.values()) {
			const src = e.manifest.source.path;
			if (src === path || src.startsWith(prefix)) out.push(e);
		}
		return out;
	}

	/** 某篇原文的首选译文 */
	forSource(sourcePath: string, preferLangOut?: string): TranslationEntry | undefined {
		const entries = this.entriesForSource(sourcePath);
		if (entries.length === 0) return undefined;
		const pool =
			preferLangOut !== undefined && entries.some((e) => e.manifest.lang.out === preferLangOut)
				? entries.filter((e) => e.manifest.lang.out === preferLangOut)
				: entries;
		return pool.reduce((best, e) => (e.manifest.createdAt > best.manifest.createdAt ? e : best));
	}

	/** 给定任意仓库路径，判断它是原文还是某组译文的一部分 */
	resolve(path: string, preferLangOut?: string): ResolvedTranslation | undefined {
		const out = this.byOutput.get(path);
		if (out) {
			const entry = this.byManifest.get(out.manifestPath);
			if (entry) return { entry, mode: out.kind };
		}
		const entry = this.forSource(path, preferLangOut);
		return entry ? { entry, mode: "original" } : undefined;
	}

	isOutputPath(path: string): boolean {
		return this.byOutput.has(path);
	}
}
