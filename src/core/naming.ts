import type { OutputKind } from "./types";

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
export const SHORT_ID_LENGTH = 6;

/** 由调用方提供随机字节（crypto.getRandomValues），这里只做映射，便于测试 */
export function shortIdFromBytes(bytes: Uint8Array): string {
	if (bytes.length < SHORT_ID_LENGTH) throw new Error("随机字节不足");
	let id = "";
	for (let i = 0; i < SHORT_ID_LENGTH; i++) {
		id += ID_ALPHABET[(bytes[i] ?? 0) % ID_ALPHABET.length];
	}
	return id;
}

export function isShortId(value: string): boolean {
	return new RegExp(`^[0-9a-z]{${SHORT_ID_LENGTH}}$`).test(value);
}

/** 文件名中替换掉 Obsidian / Windows 不允许或会破坏链接的字符 */
export function sanitizeFileName(name: string): string {
	// eslint-disable-next-line no-control-regex -- 有意剔除文件名里的控制字符
	const cleaned = name.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, "_").trim();
	// Windows 不允许以点或空格结尾
	const trimmed = cleaned.replace(/[. ]+$/, "");
	return trimmed.length > 0 ? trimmed : "untitled";
}

/** "Papers/a b.pdf" → "a b" */
export function pdfBasename(path: string): string {
	const name = path.split("/").pop() ?? path;
	return name.replace(/\.pdf$/i, "");
}

export function translationDirName(sourceBasename: string, id: string): string {
	return `${sanitizeFileName(sourceBasename)}-${id}`;
}

export function outputFileName(sourceBasename: string, langOut: string, kind: OutputKind): string {
	return `${sanitizeFileName(sourceBasename)}.${sanitizeFileName(langOut)}.${kind}.pdf`;
}

/** 用 "/" 拼接仓库内路径，去掉多余的斜杠；结果不以斜杠开头或结尾 */
export function joinVaultPath(...parts: string[]): string {
	return parts
		.flatMap((p) => p.split(/[\\/]+/))
		.filter((seg) => seg.length > 0 && seg !== ".")
		.join("/");
}

export function parentPath(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx < 0 ? "" : path.slice(0, idx);
}

/** path 是否位于 dir 目录之内（dir 为空表示仓库根目录） */
export function isInsideDir(path: string, dir: string): boolean {
	if (dir === "") return true;
	return path.startsWith(`${dir}/`);
}
