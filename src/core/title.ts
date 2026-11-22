/**
 * 从 PDF 首页的文字识别论文标题（纯逻辑，不依赖 Obsidian / pdf.js）。
 *
 * 思路：标题通常是首页上方字号最大的一段文字，可能跨几行。
 * - 跳过旋转的文字（arXiv 左侧竖排的编号水印）
 * - 同一基线、字号相近的文字片段拼成一行；字号小得多的上标（脚注标记）单独成行，不并进标题
 * - 期刊页眉、DOI、版权声明这类行不当作标题
 */

/** 一段文字，坐标为 PDF 用户空间（原点在左下，y 向上） */
export interface TextRun {
	text: string;
	/** 基线起点 */
	x: number;
	y: number;
	/** 字高 */
	size: number;
	/** 水平宽度 */
	width: number;
	/** 是否为旋转或竖排的文字 */
	rotated: boolean;
}

export interface PageText {
	/** 页面范围 [x0, y0, x1, y1] */
	view: [number, number, number, number];
	runs: TextRun[];
}

export type TitleSource = "text" | "metadata";

/** 界面上显示的候选来源 */
export const SOURCE_LABELS: Record<TitleSource, string> = {
	text: "首页文字",
	metadata: "PDF 元数据",
};

export interface TitleCandidate {
	title: string;
	source: TitleSource;
}

export interface TitleSuggestion {
	/** 推荐使用的标题 */
	primary: TitleCandidate;
	/** 与推荐不同的其他候选（供用户改选） */
	alternatives: TitleCandidate[];
}

interface Line {
	runs: TextRun[];
	y: number;
	size: number;
	text: string;
}

const MIN_LETTERS = 4;
const MAX_TITLE_LINES = 6;
const MAX_TITLE_LENGTH = 400;

/** 只看页面上方这一比例的区域 */
const TOP_FRACTION = 0.6;

function letterCount(s: string): number {
	return (s.match(/\p{L}/gu) ?? []).length;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;

function isCjk(ch: string | undefined): boolean {
	return ch !== undefined && CJK.test(ch);
}

/** 两段文字之间是否该补空格 */
function needsSpace(left: string, right: string): boolean {
	if (left === "" || right === "") return false;
	if (/\s$/.test(left) || /^\s/.test(right)) return false;
	return !(isCjk(left[left.length - 1]) || isCjk(right[0]));
}

/**
 * 小型大写字母（small caps）：标题里每个词的首字母用大字号，其余字母用小一号的大写。
 * 和大字号片段在同一行、字号明显更小的全大写片段，按小写处理。
 */
function isSmallCaps(run: TextRun, lineSize: number): boolean {
	return run.size < 0.9 * lineSize && letterCount(run.text) > 0 && run.text === run.text.toUpperCase();
}

function joinRuns(runs: TextRun[], lineSize: number): string {
	const sorted = [...runs].sort((a, b) => a.x - b.x);
	let out = "";
	let prevEnd: number | null = null;
	for (const r of sorted) {
		if (prevEnd !== null && r.x - prevEnd > 0.15 * r.size && needsSpace(out, r.text)) out += " ";
		out += isSmallCaps(r, lineSize) ? r.text.toLowerCase() : r.text;
		prevEnd = r.x + r.width;
	}
	return out.replace(/\s+/g, " ").trim();
}

function similarSize(a: number, b: number, tolerance: number): boolean {
	return Math.min(a, b) / Math.max(a, b) >= 1 - tolerance;
}

interface LineGroup {
	runs: TextRun[];
	y: number;
	size: number;
	/** 最右一段的右端，判断相邻用 */
	end: number;
}

/** 这一段文字是否属于这一行 */
function belongsTo(g: LineGroup, r: TextRun): boolean {
	const dy = Math.abs(g.y - r.y);
	const small = Math.min(g.size, r.size);
	if (dy <= 0.4 * small && similarSize(g.size, r.size, 0.2)) return true;
	// small caps：基线严格对齐、紧挨着的小一号文字也并进来（上标的基线会抬高，不受影响）
	return dy <= 0.15 * small && similarSize(g.size, r.size, 0.4) && r.x - g.end <= 1.5 * Math.max(g.size, r.size);
}

/** 把文字片段按基线和字号分成行，从上到下排列 */
function groupLines(runs: TextRun[]): Line[] {
	const groups: LineGroup[] = [];
	const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
	for (const r of sorted) {
		const g = groups.find((l) => belongsTo(l, r));
		if (g) {
			g.runs.push(r);
			g.size = Math.max(g.size, r.size);
			g.end = Math.max(g.end, r.x + r.width);
		} else {
			groups.push({ runs: [r], y: r.y, size: r.size, end: r.x + r.width });
		}
	}
	return groups
		.map((g) => ({ runs: g.runs, y: g.y, size: g.size, text: joinRuns(g.runs, g.size) }))
		.filter((l) => l.text !== "")
		.sort((a, b) => b.y - a.y);
}

/** 期刊页眉、标识符、版权声明等，不可能是标题的行 */
const NOT_TITLE_LINE = [
	/arxiv\s*:/i,
	/\bdoi\b|10\.\d{4,}\//i,
	/https?:\/\/|www\./i,
	/©|\(c\)\s*\d{4}|copyright/i,
	/\bissn\b|\bisbn\b/i,
	/\bvol(ume)?\.?\s*\d+/i,
	/journal homepage|contents lists available/i,
	/^(original\s+)?(research\s+)?(article|review|letter|communication|editorial|technical note|perspective|brief report|mini review|opinion)s?$/i,
	/^((original|research)\s+(research|paper)|research)$/i,
	/^(open access|preprint|accepted manuscript|author manuscript)$/i,
	/^[\d\s.,:;()-]+$/,
	// 期刊名（Elsevier 等版式的页眉里，期刊名的字号可能比标题还大）
	/\bjournal of\b|^(ieee|acm)\s+transactions\b/i,
];

function isTitleLike(text: string): boolean {
	if (letterCount(text) < MIN_LETTERS) return false;
	return !NOT_TITLE_LINE.some((re) => re.test(text));
}

/**
 * Elsevier 版式的页眉：「Contents lists available at ScienceDirect」/ 期刊名 / 「journal homepage: …」。
 * 夹在这两行之间的行是期刊名，即使不含 Journal 字样（如 Remote Sensing of Environment）。
 */
const MASTHEAD_ABOVE = /contents lists available/i;
const MASTHEAD_BELOW = /journal homepage/i;

function mastheadLines(lines: Line[]): Set<number> {
	const out = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		if (!MASTHEAD_ABOVE.test(lines[i]?.text ?? "")) continue;
		for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
			if (MASTHEAD_BELOW.test(lines[j]?.text ?? "")) {
				for (let k = i + 1; k < j; k++) out.add(k);
				break;
			}
		}
	}
	return out;
}

/** 合并跨行的标题：处理行尾连字符 */
function joinLines(lines: string[]): string {
	let out = "";
	for (const line of lines) {
		if (out === "") {
			out = line;
		} else if (/\p{Ll}-$/u.test(out) && /^\p{Ll}/u.test(line)) {
			out = out.slice(0, -1) + line;
		} else {
			out += needsSpace(out, line) ? ` ${line}` : line;
		}
	}
	return out;
}

/** 去掉标题首尾的脚注标记和多余标点 */
export function cleanTitle(raw: string): string {
	return raw
		.normalize("NFKC")
		.replace(/\s+/g, " ")
		.replace(/[\s*∗†‡§¶⋆★,;]+$/u, "")
		.replace(/^[\s*∗†‡§¶⋆★,;:.-]+/u, "")
		.trim();
}

/** 页面上方区域里的横排文字，按行从上到下 */
function topLines(page: PageText): Line[] {
	const [x0, y0, x1, y1] = page.view;
	const height = y1 - y0;
	if (!(height > 0) || !(x1 > x0)) return [];
	const minY = y1 - height * TOP_FRACTION;
	const runs = page.runs.filter(
		(r) =>
			!r.rotated &&
			r.size > 0 &&
			r.text.trim() !== "" &&
			r.y >= minY &&
			r.y <= y1 &&
			r.x >= x0 - 1 &&
			r.x <= x1,
	);
	return groupLines(runs);
}

/** 从首页文字里找标题；找不到时返回 null */
export function titleFromPage(page: PageText): string | null {
	const lines = topLines(page);
	const masthead = mastheadLines(lines);

	// 字号从大到小尝试：最大的一行若是页眉之类，换下一个字号
	const candidates = lines
		.map((line, index) => ({ line, index }))
		.filter(({ line, index }) => !masthead.has(index) && isTitleLike(line.text))
		.sort((a, b) => b.line.size - a.line.size || b.line.y - a.line.y);

	for (const { line, index } of candidates) {
		const picked = collectTitleLines(lines, index, line.size).filter((l) => !masthead.has(lines.indexOf(l)));
		const title = cleanTitle(joinLines(picked.map((l) => l.text)));
		if (letterCount(title) >= MIN_LETTERS && title.length <= MAX_TITLE_LENGTH && isTitleLike(title)) {
			return title;
		}
	}
	return null;
}

/** 以第 start 行为起点，向上、向下收集字号相近、行距正常的相邻行 */
function collectTitleLines(lines: Line[], start: number, size: number): Line[] {
	const first = lines[start];
	if (!first) return [];
	const picked: Line[] = [first];
	const fits = (line: Line, neighbor: Line): boolean =>
		similarSize(line.size, size, 0.15) &&
		Math.abs(neighbor.y - line.y) <= 1.9 * size &&
		isTitleLike(line.text);
	// 小字号的行（上标、脚注标记）若紧贴在标题行旁边，跳过它继续找
	const isNoise = (line: Line, neighbor: Line): boolean =>
		line.size < 0.8 * size && Math.abs(line.y - neighbor.y) <= size;

	for (const step of [-1, 1] as const) {
		let edge = first;
		for (let i = start + step; i >= 0 && i < lines.length && picked.length < MAX_TITLE_LINES; i += step) {
			const line = lines[i];
			if (!line) break;
			if (fits(line, edge)) {
				if (step < 0) picked.unshift(line);
				else picked.push(line);
				edge = line;
			} else if (!isNoise(line, edge)) {
				break;
			}
		}
	}
	return picked;
}

/** 元数据里常见的无用标题 */
const JUNK_METADATA = [
	/^untitled\b/i,
	/^microsoft (word|powerpoint)\b/i,
	/\.(docx?|pdf|tex|dvi|ps|rtf|indd|qxd|odt)$/i,
	/use style|paper title|insert title|title of (the )?paper/i,
	/^(title|paper|article|document|manuscript|draft|template|slides?)$/i,
	/^(doi:|https?:|10\.\d{4,}\/)/i,
];

/** 清理 PDF 元数据里的标题；明显无用时返回 null */
export function titleFromMetadata(raw: string | null | undefined): string | null {
	if (typeof raw !== "string") return null;
	let title = cleanTitle(raw);
	// 有的 PDF 把标题在 XMP 里重复写了两遍
	const half = title.length / 2;
	if (Number.isInteger(half) && half > 0 && title.slice(0, half) === title.slice(half)) {
		title = title.slice(0, half).trim();
	}
	if (letterCount(title) < MIN_LETTERS || title.length > MAX_TITLE_LENGTH) return null;
	if (JUNK_METADATA.some((re) => re.test(title))) return null;
	// 没有空格又带数字的，多半是稿件编号或文件名（如 TGRS-2021-01234）
	if (!/\s/.test(title) && /\d/.test(title) && !CJK.test(title)) return null;
	return title;
}

/** 比较用：只留字母和数字，忽略大小写 */
function comparable(s: string): string {
	return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function isAllCaps(s: string): boolean {
	return letterCount(s) >= MIN_LETTERS && s === s.toUpperCase() && s !== s.toLowerCase();
}

/**
 * 综合首页文字和元数据给出建议：首页文字优先（元数据常常过时或是模板残留）；
 * 两者是同一个标题而首页文字是全大写时，用元数据的大小写。
 */
export function suggestTitle(page: PageText | null, metadataTitle: string | null): TitleSuggestion | null {
	const text = page ? titleFromPage(page) : null;
	const meta = titleFromMetadata(metadataTitle);
	if (text === null && meta === null) return null;
	if (text === null && meta !== null) return { primary: { title: meta, source: "metadata" }, alternatives: [] };
	if (text !== null && meta === null) return { primary: { title: text, source: "text" }, alternatives: [] };
	if (text === null || meta === null) return null; // 不会走到这里，只为收窄类型

	const a = comparable(text);
	const b = comparable(meta);
	if (a === b) {
		const useMeta = isAllCaps(text) && !isAllCaps(meta);
		return { primary: useMeta ? { title: meta, source: "metadata" } : { title: text, source: "text" }, alternatives: [] };
	}
	return {
		primary: { title: text, source: "text" },
		alternatives: [{ title: meta, source: "metadata" }],
	};
}
