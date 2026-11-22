/**
 * 翻译队列的状态（纯逻辑，不依赖 Obsidian）。
 * 一次只运行一项；队列空闲时再加入新任务，会先清掉上一批已结束的记录。
 */

export type QueueItemState = "waiting" | "running" | "done" | "error" | "cancelled";

export interface QueueItem<T> {
	readonly id: number;
	readonly payload: T;
	state: QueueItemState;
	/** 运行中：当前阶段和进度；结束后：结果说明 */
	detail: string;
	error: string | null;
	/** 用户要求取消（运行中的任务会在下一次检查时停下） */
	cancelRequested: boolean;
}

export interface QueueSummary {
	total: number;
	done: number;
	error: number;
	cancelled: number;
}

export function isFinished(state: QueueItemState): boolean {
	return state === "done" || state === "error" || state === "cancelled";
}

export class JobQueue<T> {
	private items: QueueItem<T>[] = [];
	private nextId = 1;

	/** 还有等待或运行中的任务 */
	get busy(): boolean {
		return this.items.some((i) => !isFinished(i.state));
	}

	list(): readonly QueueItem<T>[] {
		return this.items;
	}

	/** 某个任务是否已在队列里等待或运行 */
	has(payload: T): boolean {
		return this.items.some((i) => i.payload === payload && !isFinished(i.state));
	}

	/** 加入队列；已在队列里的跳过。返回实际加入的任务 */
	add(payloads: readonly T[]): QueueItem<T>[] {
		if (!this.busy) this.items = [];
		const added: QueueItem<T>[] = [];
		for (const payload of payloads) {
			if (this.has(payload)) continue;
			const item: QueueItem<T> = {
				id: this.nextId++,
				payload,
				state: "waiting",
				detail: "等待中",
				error: null,
				cancelRequested: false,
			};
			this.items.push(item);
			added.push(item);
		}
		return added;
	}

	/** 取出下一个等待的任务并标记为运行中；没有时返回 null */
	start(): QueueItem<T> | null {
		if (this.items.some((i) => i.state === "running")) return null;
		const item = this.items.find((i) => i.state === "waiting") ?? null;
		if (item) {
			item.state = "running";
			item.detail = "准备中";
		}
		return item;
	}

	finish(item: QueueItem<T>, state: "done" | "error" | "cancelled", detail: string, error: string | null = null): void {
		item.state = state;
		item.detail = detail;
		item.error = error;
	}

	/**
	 * 取消一个任务：等待中的直接标记为已取消；运行中的只做标记，由执行方停下后再调用 finish。
	 * 返回 true 表示这个任务正在运行。
	 */
	cancel(item: QueueItem<T>): boolean {
		if (isFinished(item.state)) return false;
		item.cancelRequested = true;
		if (item.state === "waiting") {
			this.finish(item, "cancelled", "已取消");
			return false;
		}
		return true;
	}

	/** 取消全部；返回运行中的那个任务（若有） */
	cancelAll(reason = "已取消"): QueueItem<T> | null {
		let running: QueueItem<T> | null = null;
		for (const item of this.items) {
			if (item.state === "running") {
				item.cancelRequested = true;
				running = item;
			} else if (item.state === "waiting") {
				item.cancelRequested = true;
				this.finish(item, "cancelled", reason);
			}
		}
		return running;
	}

	/** 第几个（1 起）/ 共几个：已结束和运行中的都算在前面 */
	position(item: QueueItem<T>): { index: number; total: number } {
		const index = this.items.indexOf(item);
		return { index: index + 1, total: this.items.length };
	}

	summary(): QueueSummary {
		const s: QueueSummary = { total: this.items.length, done: 0, error: 0, cancelled: 0 };
		for (const i of this.items) {
			if (i.state === "done") s.done++;
			else if (i.state === "error") s.error++;
			else if (i.state === "cancelled") s.cancelled++;
		}
		return s;
	}
}

/** 一批翻译全部结束后的提示文字 */
export function summaryText(s: QueueSummary): string {
	const parts = [`完成 ${s.done} 篇`];
	if (s.error > 0) parts.push(`失败 ${s.error} 篇`);
	if (s.cancelled > 0) parts.push(`取消 ${s.cancelled} 篇`);
	return `批量翻译结束：${parts.join("，")}`;
}
