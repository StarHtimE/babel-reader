/**
 * 术语表（纯逻辑，不依赖 Obsidian）。
 *
 * 用户在 Markdown 笔记里用表格维护术语：列为「原文 | 译文」，可选「目标语言」。
 * 笔记里标题为「待审核」的小节（直到下一个同级或更高级的标题）是翻译时自动抽取、还没确认的术语，不生效。
 * 发给服务端时转成上游（BabelDOC）要求的 CSV：source,target,tgt_lng。
 */

export interface GlossaryTerm {
	source: string;
	target: string;
	/** 只对这种目标语言生效；null 表示不限 */
	lang: string | null;
}

export const PENDING_HEADING = "待审核";

const SOURCE_HEADERS = ["原文", "术语", "source", "term", "英文", "en"];
const TARGET_HEADERS = ["译文", "译名", "翻译", "target", "translation", "中文", "zh"];
const LANG_HEADERS = ["目标语言", "语言", "tgt_lng", "lang", "language"];

const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** 比较用：去掉首尾空白、合并空白、忽略大小写 */
export function termKey(source: string): string {
	return source.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeLang(lang: string): string {
	return lang.trim().toLowerCase().replace(/-/g, "_");
}

/** 按未转义的竖线切分表格行 */
function splitRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "\\" && s[i + 1] === "|") {
			cur += "|";
			i++;
		} else if (ch === "|") {
			cells.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	cells.push(cur);
	return cells.map(cleanCell);
}

/** 去掉单元格首尾的加粗、斜体、行内代码标记 */
function cleanCell(cell: string): string {
	let s = cell.trim();
	for (;;) {
		const m = /^(\*\*|__|\*|_|`)(.+)\1$/.exec(s);
		if (!m?.[2]) break;
		s = m[2].trim();
	}
	return s;
}

function findColumn(headers: string[], names: string[]): number {
	return headers.findIndex((h) => names.includes(h.trim().toLowerCase()));
}

interface TableBlock {
	/** 表头所在行号 */
	start: number;
	/** 最后一行的行号 */
	end: number;
	pending: boolean;
	rows: GlossaryTerm[];
}

/** 找出笔记里的所有表格，并标出哪些在「待审核」小节里 */
function scanTables(lines: string[]): { tables: TableBlock[]; pendingHeading: { line: number; level: number } | null } {
	const tables: TableBlock[] = [];
	let pendingHeading: { line: number; level: number } | null = null;
	let pendingLevel: number | null = null;
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (FENCE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const h = HEADING.exec(line);
		if (h) {
			const level = h[1]?.length ?? 1;
			if (pendingLevel !== null && level <= pendingLevel) pendingLevel = null;
			if ((h[2] ?? "").trim() === PENDING_HEADING) {
				pendingLevel = level;
				pendingHeading ??= { line: i, level };
			}
			continue;
		}
		const next = lines[i + 1];
		if (!line.includes("|") || next === undefined || !DELIMITER_ROW.test(next)) continue;

		const headers = splitRow(line);
		let src = findColumn(headers, SOURCE_HEADERS);
		let tgt = findColumn(headers, TARGET_HEADERS);
		const lang = findColumn(headers, LANG_HEADERS);
		if (src < 0 || tgt < 0) {
			src = 0;
			tgt = 1;
		}
		const block: TableBlock = { start: i, end: i + 1, pending: pendingLevel !== null, rows: [] };
		let j = i + 2;
		for (; j < lines.length; j++) {
			const row = lines[j] ?? "";
			if (row.trim() === "" || !row.includes("|")) break;
			const cells = splitRow(row);
			const source = cells[src] ?? "";
			const target = cells[tgt] ?? "";
			block.end = j;
			if (source === "" || target === "") continue;
			const l = lang >= 0 ? (cells[lang] ?? "").trim() : "";
			block.rows.push({ source, target, lang: l === "" ? null : l });
		}
		if (headers.length >= 2) tables.push(block);
		i = j - 1;
	}
	return { tables, pendingHeading };
}

export interface ParsedGlossary {
	/** 生效的术语（不含「待审核」小节） */
	terms: GlossaryTerm[];
	/** 笔记里出现过的所有原文（含待审核），用于回写时去重 */
	knownSources: Set<string>;
}

export function parseGlossaryNote(markdown: string): ParsedGlossary {
	const { tables } = scanTables(markdown.split(/\r?\n/));
	const terms: GlossaryTerm[] = [];
	const knownSources = new Set<string>();
	for (const t of tables) {
		for (const row of t.rows) {
			knownSources.add(termKey(row.source));
			if (!t.pending) terms.push(row);
		}
	}
	return { terms, knownSources };
}

/**
 * 合并多份术语表：后面的优先（全局 → 上级文件夹 → 原文所在文件夹），同一原文只保留一条。
 * 只保留不限语言或目标语言为 langOut 的条目。
 */
export function mergeGlossaries(lists: readonly GlossaryTerm[][], langOut: string): GlossaryTerm[] {
	const want = normalizeLang(langOut);
	const merged = new Map<string, GlossaryTerm>();
	for (const list of lists) {
		for (const term of list) {
			if (term.lang !== null && normalizeLang(term.lang) !== want) continue;
			const key = termKey(term.source);
			merged.delete(key); // 让后出现的排在后面，顺序更直观
			merged.set(key, term);
		}
	}
	return [...merged.values()];
}

function csvField(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 转成上游的 CSV；没有术语时返回 null（不发送） */
export function toGlossaryCsv(terms: readonly GlossaryTerm[]): string | null {
	if (terms.length === 0) return null;
	const lines = ["source,target,tgt_lng"];
	for (const t of terms) lines.push([t.source, t.target, t.lang ?? ""].map(csvField).join(","));
	return `${lines.join("\n")}\n`;
}

/** 解析 CSV（RFC 4180：引号内可以有逗号、换行，"" 表示一个引号）；去掉 BOM */
function parseCsvRows(text: string): string[][] {
	const s = text.replace(/^\uFEFF/, "");
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (quoted) {
			if (ch === '"' && s[i + 1] === '"') {
				field += '"';
				i++;
			} else if (ch === '"') {
				quoted = false;
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			quoted = true;
		} else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && s[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else {
			field += ch;
		}
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** 解析上游自动抽取的术语 CSV（source,target,tgt_lng） */
export function parseGlossaryCsv(text: string): GlossaryTerm[] {
	const [header, ...rows] = parseCsvRows(text);
	if (!header) return [];
	const cols = header.map((h) => h.trim().toLowerCase());
	const src = cols.indexOf("source");
	const tgt = cols.indexOf("target");
	const lang = cols.indexOf("tgt_lng");
	if (src < 0 || tgt < 0) return [];
	const out: GlossaryTerm[] = [];
	for (const r of rows) {
		const source = (r[src] ?? "").trim();
		const target = (r[tgt] ?? "").trim();
		if (source === "" || target === "") continue;
		const l = lang >= 0 ? (r[lang] ?? "").trim() : "";
		out.push({ source, target, lang: l === "" ? null : l });
	}
	return out;
}

function tableCell(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

const PENDING_TABLE_HEADER = ["| 原文 | 译文 |", "| --- | --- |"];

/** 比较原文和译文是否相同：再去掉所有空白 */
function compactKey(text: string): string {
	return termKey(text).replace(/\s+/g, "");
}

/** 英文复数的几种单数形式：operators → operator，boxes → box，libraries → library */
function singularForms(key: string): string[] {
	const out: string[] = [];
	if (key.length > 3 && key.endsWith("ies")) out.push(`${key.slice(0, -3)}y`);
	if (key.length > 2 && key.endsWith("es")) out.push(key.slice(0, -2));
	if (key.length > 1 && key.endsWith("s") && !key.endsWith("ss")) out.push(key.slice(0, -1));
	return out;
}

/**
 * 过滤上游自动抽取的术语，只留值得审核的：
 * - 去掉原文和译文相同的（人名、缩写、模型名，照抄即可，放进术语表没用）
 * - 去掉没有字母的（纯数字、符号）
 * - 去掉单复数重复的（已有 operator 时跳过 operators）
 * - 去掉笔记里已有的、这一批里重复的
 */
export function filterExtractedTerms(terms: readonly GlossaryTerm[], known: ReadonlySet<string>): GlossaryTerm[] {
	const all = new Set(known);
	for (const t of terms) all.add(termKey(t.source));
	const seen = new Set(known);
	const out: GlossaryTerm[] = [];
	for (const t of terms) {
		const key = termKey(t.source);
		if (key === "" || seen.has(key)) continue;
		seen.add(key);
		if (!/\p{L}/u.test(key)) continue;
		if (compactKey(t.source) === compactKey(t.target)) continue;
		if (singularForms(key).some((s) => all.has(s))) continue;
		out.push(t);
	}
	return out;
}

/** 待审核小节里每篇论文一个子标题；「待审核」已经是六级标题时退成普通一行 */
function sourceMarker(pendingLevel: number, sourceLabel: string): string {
	const text = `来自 ${sourceLabel.replace(/\r?\n/g, " ").trim()}`;
	return pendingLevel < 6 ? `${"#".repeat(pendingLevel + 1)} ${text}` : text;
}

/** 新建术语表笔记的初始内容 */
export function newGlossaryNote(): string {
	return [
		"# 术语表",
		"",
		"翻译时会把下面表格里的术语交给大模型，统一译法。可以加第三列「目标语言」（如 zh），只对该语言生效。",
		"",
		"| 原文 | 译文 |",
		"| --- | --- |",
		"",
	].join("\n");
}

/**
 * 把自动抽取的术语追加到笔记的「待审核」小节（没有就在末尾新建这一节），先经 filterExtractedTerms 过滤。
 * 每篇论文一个子标题「来自 <链接>」，下面是两列表格；同一篇再次翻译时追加到它的表格里。
 * 返回新文本和实际加入的条数。
 */
export function appendPendingTerms(
	markdown: string,
	newTerms: readonly GlossaryTerm[],
	sourceLabel: string,
): { text: string; added: number } {
	const fresh = filterExtractedTerms(newTerms, parseGlossaryNote(markdown).knownSources);
	if (fresh.length === 0) return { text: markdown, added: 0 };

	const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
	const lines = markdown.split(/\r?\n/);
	const rows = fresh.map((t) => `| ${tableCell(t.source)} | ${tableCell(t.target)} |`);
	const { tables, pendingHeading } = scanTables(lines);

	if (!pendingHeading) {
		while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
		lines.push(
			"",
			`## ${PENDING_HEADING}`,
			"",
			"> 翻译时自动抽取的术语，还没有生效。确认无误后挪到上面的表格里；不需要的直接删掉。",
			"",
			sourceMarker(2, sourceLabel),
			"",
			...PENDING_TABLE_HEADER,
			...rows,
			"",
		);
		return { text: lines.join(eol), added: fresh.length };
	}

	// 「待审核」小节的范围：到下一个同级或更高级的标题为止
	let sectionEnd = lines.length;
	for (let i = pendingHeading.line + 1; i < lines.length; i++) {
		const h = HEADING.exec(lines[i] ?? "");
		if (h && (h[1]?.length ?? 1) <= pendingHeading.level) {
			sectionEnd = i;
			break;
		}
	}

	// 这篇论文已有子标题：追加到它下面的表格（到下一个标题为止）
	const marker = sourceMarker(pendingHeading.level, sourceLabel);
	let markerLine = -1;
	for (let i = pendingHeading.line + 1; i < sectionEnd; i++) {
		if ((lines[i] ?? "").trim() === marker) {
			markerLine = i;
			break;
		}
	}
	if (markerLine >= 0) {
		let stop = sectionEnd;
		for (let i = markerLine + 1; i < sectionEnd; i++) {
			if (HEADING.test(lines[i] ?? "")) {
				stop = i;
				break;
			}
		}
		const table = tables.find((t) => t.pending && t.start > markerLine && t.start < stop);
		if (table) {
			lines.splice(table.end + 1, 0, ...rows);
		} else {
			lines.splice(markerLine + 1, 0, "", ...PENDING_TABLE_HEADER, ...rows);
		}
		return { text: lines.join(eol), added: fresh.length };
	}

	// 新的一篇：在小节末尾加子标题和表格
	let at = sectionEnd;
	while (at > pendingHeading.line + 1 && (lines[at - 1] ?? "").trim() === "") at--;
	// 前面是标题或正文：空一行再写；后面已经有空行就不再补
	const block = ["", marker, "", ...PENDING_TABLE_HEADER, ...rows];
	const after = lines[at];
	if (after !== undefined && after.trim() !== "") block.push("");
	lines.splice(at, 0, ...block);
	return { text: lines.join(eol), added: fresh.length };
}
