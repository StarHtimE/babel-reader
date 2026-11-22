import { MANIFEST_FILE_NAME, type TranslationManifest } from "./manifest";
import {
	isInsideDir,
	joinVaultPath,
	outputFileName,
	parentPath,
	pdfBasename,
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
 * - 译文目录和文件仍是插件生成的名字时，改成按新文件名生成的名字（名字没变就不动）；
 *   用户手动改过的名字不动。旧版生成的不限长的名字也算插件生成的，会顺便改成限长的名字
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
	const generated =
		isInsideDir(dir, translationsDir) &&
		isGeneratedName(dirName, (max) => translationDirName(oldBase, old.id, max));
	if (generated) {
		for (const kind of OUTPUT_KINDS) {
			const name = old.outputs[kind];
			if (name === undefined) continue;
			if (!isGeneratedName(name, (max) => outputFileName(oldBase, old.lang.out, kind, max))) continue;
			const next = outputFileName(newBase, old.lang.out, kind);
			if (next === name) continue;
			const from = joinVaultPath(dir, name);
			const to = joinVaultPath(dir, next);
			if (!exists(from) || exists(to)) continue;
			fileRenames.push({ kind, from, to });
			outputs[kind] = next;
		}
		const nextDirName = translationDirName(newBase, old.id);
		const newDir = joinVaultPath(parentPath(dir), nextDirName);
		if (nextDirName !== dirName && !exists(newDir)) dirRename = { from: dir, to: newDir };
	}

	return {
		manifest: { ...old, source: { ...old.source, path: newSourcePath }, outputs },
		fileRenames,
		dirRename,
		manifestPath: joinVaultPath(dirRename?.to ?? dir, MANIFEST_FILE_NAME),
	};
}

/** 是否为插件生成的名字：当前规则（限长），或旧版规则（不限长） */
function isGeneratedName(actual: string, make: (maxLength?: number) => string): boolean {
	return actual === make() || actual === make(Infinity);
}

/** 原文（或它所在的文件夹）从 oldPath 改到 newPath 后，某篇原文的新路径 */
export function movedSourcePath(sourcePath: string, oldPath: string, newPath: string): string | null {
	if (sourcePath === oldPath) return newPath;
	if (sourcePath.startsWith(`${oldPath}/`)) return newPath + sourcePath.slice(oldPath.length);
	return null;
}
