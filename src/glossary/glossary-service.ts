import { normalizePath, TFile, TFolder, type App } from "obsidian";
import {
	appendPendingTerms,
	mergeGlossaries,
	newGlossaryNote,
	parseGlossaryCsv,
	parseGlossaryNote,
	toGlossaryCsv,
} from "../core/glossary";
import { joinVaultPath } from "../core/naming";
import type { BabelReaderSettings } from "../core/settings-model";

export interface JobGlossary {
	/** 发给服务端的 CSV；没有术语时为 null */
	csv: string | null;
	/** 用到的术语表笔记（按优先级从低到高），记进 manifest */
	notes: string[];
	/** 自动抽取的术语写回到哪篇笔记；null 表示不写回 */
	writeBackPath: string | null;
}

/**
 * 术语表笔记：全局术语表（设置里指定）+ 原文所在文件夹及其上级里名为「术语表」的笔记。
 * 越靠近原文的优先级越高。只读写仓库里的 Markdown 笔记。
 */
export class GlossaryService {
	constructor(
		private readonly app: App,
		private readonly getSettings: () => BabelReaderSettings,
	) {}

	/** 全局术语表的路径（规范化，补上 .md）；没设置时返回 null */
	globalPath(): string | null {
		const raw = this.getSettings().glossaryPath.trim();
		if (raw === "") return null;
		const p = normalizePath(raw);
		return p.toLowerCase().endsWith(".md") ? p : `${p}.md`;
	}

	/** 对某篇原文生效的术语表笔记路径（存在的），优先级从低到高 */
	notesFor(source: TFile): string[] {
		const out: string[] = [];
		const global = this.globalPath();
		if (global && this.app.vault.getAbstractFileByPath(global) instanceof TFile) out.push(global);

		const name = this.getSettings().folderGlossaryName.trim();
		if (name !== "") {
			// 从仓库根目录到原文所在文件夹
			const folders: TFolder[] = [];
			for (let f = source.parent; f; f = f.parent) folders.unshift(f);
			for (const folder of folders) {
				const p = normalizePath(joinVaultPath(folder.isRoot() ? "" : folder.path, `${name}.md`));
				if (p !== global && this.app.vault.getAbstractFileByPath(p) instanceof TFile) out.push(p);
			}
		}
		return out;
	}

	/** 提交翻译前：读出并合并术语表 */
	async forJob(source: TFile, langOut: string): Promise<JobGlossary> {
		const notes = this.notesFor(source);
		const lists = [];
		for (const p of notes) {
			const f = this.app.vault.getAbstractFileByPath(p);
			if (f instanceof TFile) lists.push(parseGlossaryNote(await this.app.vault.cachedRead(f)).terms);
		}
		const csv = toGlossaryCsv(mergeGlossaries(lists, langOut));
		// 写回到离原文最近的那篇；一篇都没有时写到全局术语表（设置了路径才会新建）
		const writeBackPath = notes[notes.length - 1] ?? this.globalPath();
		return { csv, notes, writeBackPath };
	}

	/**
	 * 把自动抽取的术语追加到术语表笔记的「待审核」小节（已有的原文跳过）。
	 * 笔记不存在时新建。返回实际加入的条数。
	 */
	async writeBack(path: string, csvText: string, source: TFile): Promise<number> {
		const terms = parseGlossaryCsv(csvText);
		if (terms.length === 0) return 0;
		const link = this.app.fileManager.generateMarkdownLink(source, path);
		let file = this.app.vault.getAbstractFileByPath(path);
		if (!file) {
			await this.ensureParent(path);
			file = await this.app.vault.create(path, newGlossaryNote());
		}
		if (!(file instanceof TFile)) throw new Error(`「${path}」不是笔记文件`);
		let added = 0;
		await this.app.vault.process(file, (text) => {
			const r = appendPendingTerms(text, terms, link);
			added = r.added;
			return r.text;
		});
		return added;
	}

	private async ensureParent(path: string): Promise<void> {
		const parts = path.split("/").slice(0, -1);
		let current = "";
		for (const seg of parts) {
			current = current === "" ? seg : `${current}/${seg}`;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`「${current}」已存在且不是文件夹`);
			await this.app.vault.createFolder(current);
		}
	}
}
