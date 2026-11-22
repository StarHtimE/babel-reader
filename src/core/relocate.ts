import { MANIFEST_FILE_NAME, type TranslationManifest } from "./manifest";
import {
	isInsideDir,
	joinVaultPath,
	outputFileName,
	parentPath,
	pdfBasename,
	sanitizeFileName,
	translationDirName,
} from "./naming";
import { entryDir, type TranslationEntry } from "./translation-index";
import { OUTPUT_KINDS, type OutputKind } from "./types";

export interface PathRename {
	from: string;
	to: string;
}

/** 原文改名或移动后，一组译文要做的改动 */
export interface RelocationPlan {
	/** 更新后的 manifest（原文路径、译文文件名） */
	manifest: TranslationManifest;
	/** 先在原目录里给译文文件改名 */
	fileRenames: (PathRename & { kind: OutputKind })[];
	/** 再给译文目录改名；不需要时为 null */
	dirRename: PathRename | null;
	/** 改完之后 manifest.json 的路径 */
	manifestPath: string;
}

/**
 * 原文从旧路径改到 newSourcePath 后，计算这组译文该怎么跟着改：
 * - manifest 的 source.path 总是更新
 * - 只有文件名（basename）变了，且译文目录和文件仍是插件生成的名字时，才跟着改名；
 *   用户手动改过的名字不动
 * - 目标名字已被占用（exists 返回 true）时跳过那一项
 */
export function planRelocation(
	entry: TranslationEntry,
	newSourcePath: string,
	translationsDir: string,
	exists: (path: string) => boolean,
): RelocationPlan {
	const old = entry.manifest;
	const oldBase = pdfBasename(old.source.path);
	const newBase = pdfBasename(newSourcePath);
	const dir = entryDir(entry);
	const outputs: Partial<Record<OutputKind, string>> = { ...old.outputs };
	const fileRenames: RelocationPlan["fileRenames"] = [];
	let dirRename: PathRename | null = null;

	const dirName = dir.split("/").pop() ?? dir;
	const generated = dirName === translationDirName(oldBase, old.id) && isInsideDir(dir, translationsDir);
	if (generated && sanitizeFileName(oldBase) !== sanitizeFileName(newBase)) {
		for (const kind of OUTPUT_KINDS) {
			const name = old.outputs[kind];
			if (name !== outputFileName(oldBase, old.lang.out, kind)) continue;
			const next = outputFileName(newBase, old.lang.out, kind);
			const from = joinVaultPath(dir, name);
			const to = joinVaultPath(dir, next);
			if (!exists(from) || exists(to)) continue;
			fileRenames.push({ kind, from, to });
			outputs[kind] = next;
		}
		const newDir = joinVaultPath(parentPath(dir), translationDirName(newBase, old.id));
		if (!exists(newDir)) dirRename = { from: dir, to: newDir };
	}

	return {
		manifest: { ...old, source: { ...old.source, path: newSourcePath }, outputs },
		fileRenames,
		dirRename,
		manifestPath: joinVaultPath(dirRename?.to ?? dir, MANIFEST_FILE_NAME),
	};
}

/** 原文（或它所在的文件夹）从 oldPath 改到 newPath 后，某篇原文的新路径 */
export function movedSourcePath(sourcePath: string, oldPath: string, newPath: string): string | null {
	if (sourcePath === oldPath) return newPath;
	if (sourcePath.startsWith(`${oldPath}/`)) return newPath + sourcePath.slice(oldPath.length);
	return null;
}
