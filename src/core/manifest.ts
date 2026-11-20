import { ValidationError } from "./errors";
import { isShortId } from "./naming";
import type { OutputKind } from "./types";
import { expectRecord, expectString, isOutputKind, optionalString } from "./validate";

export const MANIFEST_SCHEMA = 1;
export const MANIFEST_FILE_NAME = "manifest.json";

export interface TranslationManifest {
	schema: typeof MANIFEST_SCHEMA;
	id: string;
	source: { path: string; sha256: string };
	lang: { in: string; out: string };
	/** 值为译文目录内的文件名 */
	outputs: Partial<Record<OutputKind, string>>;
	options: { pages: string | null; profile: string | null; glossary: string | null };
	engine: { server: string; pdf2zh_next: string; babeldoc: string };
	createdAt: string;
}

/**
 * 把旧版本 manifest 迁移到当前 schema。
 * 目前只有 schema 1；以后升级 schema 时在这里加迁移步骤，不能直接改解析逻辑。
 */
export function migrateManifest(data: Record<string, unknown>): Record<string, unknown> {
	const schema = data.schema;
	if (schema === MANIFEST_SCHEMA) return data;
	if (typeof schema === "number" && schema > MANIFEST_SCHEMA) {
		throw new ValidationError(`manifest schema ${schema} 比插件支持的更新，请升级插件`);
	}
	throw new ValidationError("manifest 缺少有效的 schema");
}

function isSafeFileName(name: string): boolean {
	return name.length > 0 && !/[\\/]/.test(name) && name !== "." && name !== "..";
}

export function parseManifest(raw: unknown): TranslationManifest {
	const data = migrateManifest(expectRecord(raw, "manifest"));

	const id = expectString(data, "id", "manifest");
	if (!isShortId(id)) throw new ValidationError("manifest.id 格式不正确");

	const source = expectRecord(data.source, "manifest.source");
	const sourcePath = expectString(source, "path", "manifest.source");
	if (sourcePath === "") throw new ValidationError("manifest.source.path 为空");
	const sha256 = expectString(source, "sha256", "manifest.source");
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new ValidationError("manifest.source.sha256 格式不正确");

	const lang = expectRecord(data.lang, "manifest.lang");
	const langIn = expectString(lang, "in", "manifest.lang");
	const langOut = expectString(lang, "out", "manifest.lang");

	const outputsRaw = expectRecord(data.outputs, "manifest.outputs");
	const outputs: Partial<Record<OutputKind, string>> = {};
	for (const [key, value] of Object.entries(outputsRaw)) {
		if (!isOutputKind(key)) continue; // 忽略未来可能新增的种类
		if (typeof value !== "string" || !isSafeFileName(value)) {
			throw new ValidationError(`manifest.outputs.${key} 不是合法文件名`);
		}
		outputs[key] = value;
	}
	if (Object.keys(outputs).length === 0) throw new ValidationError("manifest.outputs 为空");

	const optionsRaw = data.options === undefined ? {} : expectRecord(data.options, "manifest.options");
	const engineRaw = data.engine === undefined ? {} : expectRecord(data.engine, "manifest.engine");

	return {
		schema: MANIFEST_SCHEMA,
		id,
		source: { path: sourcePath, sha256 },
		lang: { in: langIn, out: langOut },
		outputs,
		options: {
			pages: optionalString(optionsRaw, "pages", "manifest.options"),
			profile: optionalString(optionsRaw, "profile", "manifest.options"),
			glossary: optionalString(optionsRaw, "glossary", "manifest.options"),
		},
		engine: {
			server: optionalString(engineRaw, "server", "manifest.engine") ?? "",
			pdf2zh_next: optionalString(engineRaw, "pdf2zh_next", "manifest.engine") ?? "",
			babeldoc: optionalString(engineRaw, "babeldoc", "manifest.engine") ?? "",
		},
		createdAt: expectString(data, "createdAt", "manifest"),
	};
}

export function serializeManifest(manifest: TranslationManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}
