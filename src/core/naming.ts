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

/** 由标题生成的文件名（不含扩展名）的默认长度上限：译文路径里会出现两次，留出余量 */
export const TITLE_FILE_NAME_MAX = 120;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * 把论文标题变成可用的文件名（不含扩展名）：
 * - 冒号换成「 - 」，斜杠和竖线换成「-」，方括号换成圆括号（方括号、#、^ 会破坏 Obsidian 链接）
 * - 去掉 Windows 不允许的字符，合并空白，去掉结尾的点和空格
 * - 超长时在词边界截断
 * 结果为空时返回 null。
 */
export function titleToFileName(title: string, maxLength = TITLE_FILE_NAME_MAX): string | null {
	let s = title
		.normalize("NFKC")
		// eslint-disable-next-line no-control-regex -- 有意剔除控制字符
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s*:\s*/g, " - ")
		.replace(/\s*[\\/|]\s*/g, "-")
		.replace(/"/g, "'")
		.replace(/\[/g, "(")
		.replace(/\]/g, ")")
		.replace(/[*?<>#^]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (s.length > maxLength) {
		const cut = s.slice(0, maxLength);
		const space = cut.lastIndexOf(" ");
		s = space >= maxLength * 0.6 ? cut.slice(0, space) : cut;
		s = s.replace(/[\s,;.\-–—(]+$/u, "");
	}
	s = s.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
	if (s === "") return null;
	if (WINDOWS_RESERVED.test(s)) s = `${s}_`;
	return s;
}

/**
 * 在 dir 里为 base + ext 找一个不重名的路径："a.pdf" → "a (2).pdf" → "a (3).pdf"。
 * taken 判断某个文件名是否已被占用（调用方按大小写不敏感比较，Windows 上 A.pdf 与 a.pdf 冲突）。
 */
export function uniqueFileName(base: string, ext: string, taken: (name: string) => boolean): string {
	const first = `${base}${ext}`;
	if (!taken(first)) return first;
	for (let n = 2; n < 1000; n++) {
		const name = `${base} (${n})${ext}`;
		if (!taken(name)) return name;
	}
	throw new Error("找不到不重名的文件名");
}
