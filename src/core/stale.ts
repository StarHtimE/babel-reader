/**
 * 过期检测：原文的 sha256 与 manifest 里记录的不一致，说明翻译之后原文内容变了。
 * 计算哈希要读整个文件，所以按 修改时间 + 大小 缓存：两者都没变就沿用上次的结果。
 */

export interface FileStamp {
	mtime: number;
	size: number;
}

export type Freshness = "fresh" | "stale" | "unknown";

export class HashCache {
	private map = new Map<string, FileStamp & { sha256: string }>();

	/** 文件没变时返回缓存的哈希，否则返回 undefined */
	get(path: string, stamp: FileStamp): string | undefined {
		const hit = this.map.get(path);
		return hit && hit.mtime === stamp.mtime && hit.size === stamp.size ? hit.sha256 : undefined;
	}

	set(path: string, stamp: FileStamp, sha256: string): void {
		this.map.set(path, { ...stamp, sha256 });
	}

	delete(path: string): void {
		this.map.delete(path);
	}

	/** 文件或文件夹改名：缓存跟着搬过去 */
	rename(oldPath: string, newPath: string): void {
		const prefix = `${oldPath}/`;
		for (const [p, v] of [...this.map]) {
			if (p === oldPath || p.startsWith(prefix)) {
				this.map.delete(p);
				this.map.set(newPath + p.slice(oldPath.length), v);
			}
		}
	}
}

/** currentSha256 为 undefined 表示还没算出来 */
export function freshness(manifestSha256: string, currentSha256: string | undefined): Freshness {
	if (currentSha256 === undefined) return "unknown";
	return currentSha256 === manifestSha256 ? "fresh" : "stale";
}
