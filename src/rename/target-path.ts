import { normalizePath, TFolder, type TFile } from "obsidian";
import { joinVaultPath, titleToFileName, uniqueFileName } from "../core/naming";

/**
 * 把输入的文件名变成 file 所在文件夹里的最终路径（重名时加序号）；文件名无效时返回 null。
 * claimed：同一批里前面的文件已经占用的路径（小写），批量重命名时避免互相撞名。
 * Windows 上文件名不区分大小写，所以一律按小写比较。
 */
export function targetPathFor(file: TFile, name: string, claimed: ReadonlySet<string> = new Set()): string | null {
	const base = titleToFileName(name);
	if (base === null) return null;
	const parent = file.parent;
	const siblings = parent instanceof TFolder ? parent.children : [];
	const dir = parent && !parent.isRoot() ? parent.path : "";
	const taken = (n: string) =>
		claimed.has(joinVaultPath(dir, n).toLowerCase()) ||
		siblings.some((c) => c !== file && c.name.toLowerCase() === n.toLowerCase());
	const fileName = uniqueFileName(base, `.${file.extension}`, taken);
	return normalizePath(joinVaultPath(dir, fileName));
}
