import { normalizePath, TFile, TFolder, type App, type TAbstractFile } from "obsidian";
import { errorMessage } from "../core/errors";
import { movedSourcePath, planRelocation } from "../core/relocate";
import {
	MANIFEST_FILE_NAME,
	MANIFEST_SCHEMA,
	parseManifest,
	serializeManifest,
	type TranslationManifest,
} from "../core/manifest";
import {
	isInsideDir,
	joinVaultPath,
	outputFileName,
	pdfBasename,
	shortIdFromBytes,
	translationDirName,
} from "../core/naming";
import {
	entryDir,
	pathForMode,
	TranslationIndex,
	type ResolvedTranslation,
	type TranslationEntry,
} from "../core/translation-index";
import type { HealthInfo, OutputKind, ViewMode } from "../core/types";

export interface SaveTranslationParams {
	source: TFile;
	sourceSha256: string;
	langIn: string;
	langOut: string;
	files: Partial<Record<OutputKind, ArrayBuffer>>;
	profile: string | null;
	pages: string | null;
	engine: HealthInfo;
}

/**
 * 译文目录与 manifest 的读写，以及 原文 ⇄ 译文 索引。
 * 只通过 Vault API 读写；原文只读，写入只发生在译文目录里。
 */
export class TranslationStore {
	readonly index = new TranslationIndex();
	private listeners = new Set<() => void>();
	private sourceDeletedListeners = new Set<(entries: TranslationEntry[]) => void>();
	/** 正在跟随原文改名的译文目录（新旧路径）：期间忽略这些路径上的仓库事件，改完后直接更新索引 */
	private relocating = new Set<string>();
	/** 首次扫描完成前忽略仓库事件（启动时 Obsidian 会为每个文件触发 create） */
	private ready = false;

	constructor(
		private readonly app: App,
		private readonly getTranslationsDir: () => string,
		private readonly getPreferredLangOut: () => string,
	) {}

	translationsDir(): string {
		const dir = normalizePath(this.getTranslationsDir().trim() || "_translations");
		return dir === "/" ? "" : dir;
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private emitChange(): void {
		for (const cb of this.listeners) cb();
	}

	/** 原文被删除、而它的译文还在时通知（由界面询问是否一并删除译文） */
	onSourceDeleted(cb: (entries: TranslationEntry[]) => void): () => void {
		this.sourceDeletedListeners.add(cb);
		return () => this.sourceDeletedListeners.delete(cb);
	}

	private isRelocating(path: string): boolean {
		for (const dir of this.relocating) {
			if (path === dir || path.startsWith(`${dir}/`)) return true;
		}
		return false;
	}

	/** 扫描译文目录下所有 manifest，重建索引 */
	async rebuild(): Promise<void> {
		const dir = this.translationsDir();
		const manifests = this.app.vault
			.getFiles()
			.filter((f) => f.name === MANIFEST_FILE_NAME && isInsideDir(f.path, dir));
		this.index.clear();
		for (const file of manifests) {
			await this.loadManifest(file);
		}
		this.ready = true;
		this.emitChange();
	}

	private async loadManifest(file: TFile): Promise<TranslationEntry | null> {
		try {
			const manifest = parseManifest(JSON.parse(await this.app.vault.read(file)));
			const entry: TranslationEntry = { manifestPath: file.path, manifest };
			this.index.set(entry);
			return entry;
		} catch (err) {
			// 文件改坏了：旧的索引条目也要去掉
			this.index.remove(file.path);
			console.warn(`[babel-reader] 跳过无效的 manifest：${file.path}`, errorMessage(err));
			return null;
		}
	}

	private isManifestFile(file: TAbstractFile): file is TFile {
		return (
			file instanceof TFile &&
			file.name === MANIFEST_FILE_NAME &&
			isInsideDir(file.path, this.translationsDir())
		);
	}

	// ---- 仓库事件：保持索引与译文目录一致 ------------------------------

	/** 文件或文件夹被删除（删文件夹时 path 是文件夹路径） */
	handleDelete(file: TAbstractFile): void {
		if (!this.ready || this.isRelocating(file.path)) return;
		const touched = this.index.touches(file.path);
		this.index.removeUnder(file.path);
		if (touched) this.emitChange();

		// 原文一侧：译文还在，交给界面询问是否一并删除
		if (this.isInTranslationsDir(file.path)) return;
		const orphans = this.index.entriesUnderSource(file.path);
		if (orphans.length > 0) for (const cb of this.sourceDeletedListeners) cb(orphans);
	}

	/** 文件或文件夹被重命名 / 移动 */
	async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (!this.ready || this.isRelocating(oldPath) || this.isRelocating(file.path)) return;
		if (!this.isInTranslationsDir(oldPath)) await this.followSource(oldPath, file.path);
		let changed = this.index.touches(oldPath);
		this.index.removeUnder(oldPath);
		const moved =
			file instanceof TFolder
				? this.app.vault
						.getFiles()
						.filter((f) => f.path.startsWith(`${file.path}/`) && this.isManifestFile(f))
				: this.isManifestFile(file)
					? [file]
					: [];
		for (const m of moved) {
			if (await this.loadManifest(m)) changed = true;
		}
		if (changed || this.index.touches(file.path)) this.emitChange();
	}

	private isInTranslationsDir(path: string): boolean {
		const dir = this.translationsDir();
		return dir !== "" && (path === dir || isInsideDir(path, dir));
	}

	/**
	 * 原文（或它所在的文件夹）从 oldPath 改到 newPath：更新 manifest 里的原文路径；
	 * 文件名变了时，译文目录和译文文件也跟着改名（只改插件生成的名字，见 planRelocation）。
	 */
	private async followSource(oldPath: string, newPath: string): Promise<void> {
		const entries = this.index.entriesUnderSource(oldPath);
		if (entries.length === 0) return;
		for (const entry of entries) {
			const next = movedSourcePath(entry.manifest.source.path, oldPath, newPath);
			if (next === null) continue;
			try {
				await this.relocate(entry, next);
			} catch (err) {
				console.error(`[babel-reader] 译文没能跟随原文改名：${entry.manifestPath}`, err);
			}
		}
		this.emitChange();
	}

	private async relocate(entry: TranslationEntry, newSourcePath: string): Promise<void> {
		const exists = (p: string) => this.app.vault.getAbstractFileByPath(p) !== null;
		const plan = planRelocation(entry, newSourcePath, this.translationsDir(), exists);
		// 先更新索引：同一次改名的后续事件（例如文件夹里每个文件各触发一次）不会重复处理
		this.index.set({ manifestPath: entry.manifestPath, manifest: plan.manifest });

		const guarded = [entryDir(entry), ...(plan.dirRename ? [plan.dirRename.to] : [])];
		for (const g of guarded) this.relocating.add(g);
		// 实际做成了哪些改名，就记哪些：中途失败时 manifest 仍与磁盘一致
		const outputs = { ...entry.manifest.outputs };
		let manifestPath = entry.manifestPath;
		try {
			for (const r of plan.fileRenames) {
				const f = this.app.vault.getAbstractFileByPath(r.from);
				if (!(f instanceof TFile)) continue;
				await this.app.fileManager.renameFile(f, r.to);
				outputs[r.kind] = plan.manifest.outputs[r.kind];
			}
			if (plan.dirRename) {
				const folder = this.app.vault.getAbstractFileByPath(plan.dirRename.from);
				if (folder instanceof TFolder) {
					await this.app.fileManager.renameFile(folder, plan.dirRename.to);
					manifestPath = plan.manifestPath;
				}
			}
		} finally {
			const manifest = { ...plan.manifest, outputs };
			try {
				await this.writeText(manifestPath, serializeManifest(manifest));
			} finally {
				for (const g of guarded) this.relocating.delete(g);
				this.index.remove(entry.manifestPath);
				this.index.set({ manifestPath, manifest });
			}
		}
	}

	/** 把几组译文的目录移到回收站（遵循 Obsidian「删除文件」设置）；返回删除的组数 */
	async trashEntries(entries: TranslationEntry[]): Promise<number> {
		let count = 0;
		for (const e of entries) {
			const dir = entryDir(e);
			// 只删除译文目录里、仍在索引中的那组译文的目录
			if (!this.isInTranslationsDir(dir) || this.index.get(e.manifestPath) === undefined) continue;
			const folder = this.app.vault.getAbstractFileByPath(dir);
			if (!(folder instanceof TFolder)) continue;
			await this.app.fileManager.trashFile(folder);
			count++;
		}
		return count;
	}

	/** 原文是否还在（删除后可能被同步工具或回收站恢复） */
	sourceExists(entry: TranslationEntry): boolean {
		return this.app.vault.getAbstractFileByPath(entry.manifest.source.path) instanceof TFile;
	}

	/** 文件新建或被修改（包括同步工具写入、从回收站恢复） */
	async handleCreateOrModify(file: TAbstractFile): Promise<void> {
		if (!this.ready || this.isRelocating(file.path)) return;
		if (this.isManifestFile(file)) {
			await this.loadManifest(file);
			this.emitChange();
		} else if (this.index.touches(file.path)) {
			// 某个译文文件回来了
			this.emitChange();
		}
	}

	resolve(path: string): ResolvedTranslation | undefined {
		return this.index.resolve(path, this.getPreferredLangOut());
	}

	/** 找到某组译文在指定模式下对应的文件；文件已不存在时返回 null */
	fileForMode(entry: TranslationEntry, mode: ViewMode): TFile | null {
		const p = pathForMode(entry, mode);
		if (p === null) return null;
		const f = this.app.vault.getAbstractFileByPath(p);
		return f instanceof TFile ? f : null;
	}

	/** 写入一组译文：同一原文、同一目标语言复用原来的目录，否则新建 */
	async save(params: SaveTranslationParams): Promise<TranslationEntry> {
		const existing = this.index
			.entriesForSource(params.source.path)
			.find(
				(e) =>
					e.manifest.lang.out === params.langOut &&
					isInsideDir(entryDir(e), this.translationsDir()),
			);

		let id: string;
		let dir: string;
		if (existing) {
			id = existing.manifest.id;
			dir = entryDir(existing);
		} else {
			id = this.newShortId();
			dir = joinVaultPath(this.translationsDir(), translationDirName(pdfBasename(params.source.path), id));
		}
		dir = normalizePath(dir);
		// 译文只写进译文目录：目录不在其中（例如用户改过译文目录设置）时拒绝写入
		if (!isInsideDir(dir, this.translationsDir())) {
			throw new Error(`译文目录「${dir}」不在设置的译文目录之内`);
		}
		await this.ensureFolder(dir);

		const basename = pdfBasename(params.source.path);
		const outputs: Partial<Record<OutputKind, string>> = {};
		for (const kind of ["mono", "dual"] as const) {
			const data = params.files[kind];
			if (!data) continue;
			const name = outputFileName(basename, params.langOut, kind);
			const target = normalizePath(joinVaultPath(dir, name));
			// 原文是正本，任何情况下都不覆盖
			if (target === params.source.path) throw new Error("译文路径与原文相同，已中止写入");
			await this.writeBinary(target, data);
			outputs[kind] = name;
		}

		const manifest: TranslationManifest = {
			schema: MANIFEST_SCHEMA,
			id,
			source: { path: params.source.path, sha256: params.sourceSha256 },
			lang: { in: params.langIn, out: params.langOut },
			outputs,
			options: { pages: params.pages, profile: params.profile, glossary: null },
			engine: {
				server: params.engine.server_version,
				pdf2zh_next: params.engine.pdf2zh_next_version,
				babeldoc: params.engine.babeldoc_version,
			},
			createdAt: new Date().toISOString(),
		};
		const manifestPath = normalizePath(joinVaultPath(dir, MANIFEST_FILE_NAME));
		await this.writeText(manifestPath, serializeManifest(manifest));

		const entry: TranslationEntry = { manifestPath, manifest };
		this.index.set(entry);
		this.emitChange();
		return entry;
	}

	private newShortId(): string {
		for (let attempt = 0; attempt < 20; attempt++) {
			const bytes = new Uint8Array(6);
			crypto.getRandomValues(bytes);
			const id = shortIdFromBytes(bytes);
			const clash = this.app.vault
				.getAllLoadedFiles()
				.some((f) => f instanceof TFolder && f.name.endsWith(`-${id}`));
			if (!clash) return id;
		}
		throw new Error("无法生成不重复的译文 ID");
	}

	private async ensureFolder(path: string): Promise<void> {
		let current = "";
		for (const seg of path.split("/")) {
			current = current === "" ? seg : `${current}/${seg}`;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`「${current}」已存在且不是文件夹`);
			await this.app.vault.createFolder(current);
		}
	}

	private async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, data);
		} else if (existing) {
			throw new Error(`「${path}」已存在且不是文件`);
		} else {
			await this.app.vault.createBinary(path, data);
		}
	}

	private async writeText(path: string, text: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, text);
		} else if (existing) {
			throw new Error(`「${path}」已存在且不是文件`);
		} else {
			await this.app.vault.create(path, text);
		}
	}
}
