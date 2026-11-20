import { normalizePath, TFile, TFolder, type App, type TAbstractFile } from "obsidian";
import { errorMessage } from "../core/errors";
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
	// （这里只同步译文一侧；原文重命名 / 删除的跟踪属于 v0.2）

	/** 文件或文件夹被删除（删文件夹时 path 是文件夹路径） */
	handleDelete(file: TAbstractFile): void {
		if (!this.ready) return;
		const touched = this.index.touches(file.path);
		this.index.removeUnder(file.path);
		if (touched) this.emitChange();
	}

	/** 文件或文件夹被重命名 / 移动 */
	async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (!this.ready) return;
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

	/** 文件新建或被修改（包括同步工具写入、从回收站恢复） */
	async handleCreateOrModify(file: TAbstractFile): Promise<void> {
		if (!this.ready) return;
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
