import { describe, expect, it } from "vitest";
import { JobQueue, summaryText } from "../src/core/queue";

describe("JobQueue", () => {
	it("按顺序一次运行一个，重复加入的跳过", () => {
		const q = new JobQueue<string>();
		expect(q.add(["a", "b", "a"]).map((i) => i.payload)).toEqual(["a", "b"]);
		expect(q.busy).toBe(true);
		const a = q.start();
		expect(a?.payload).toBe("a");
		expect(q.start()).toBeNull(); // a 还在运行
		expect(q.add(["a", "c"]).map((i) => i.payload)).toEqual(["c"]);
		if (!a) throw new Error("unreachable");
		expect(q.position(a)).toEqual({ index: 1, total: 3 });
		q.finish(a, "done", "完成");
		expect(q.start()?.payload).toBe("b");
	});

	it("取消：等待中的立即结束，运行中的只做标记", () => {
		const q = new JobQueue<string>();
		const [a, b, c] = q.add(["a", "b", "c"]);
		if (!a || !b || !c) throw new Error("unreachable");
		q.start();
		expect(q.cancel(b)).toBe(false);
		expect(b.state).toBe("cancelled");
		expect(q.cancel(a)).toBe(true);
		expect(a.state).toBe("running");
		expect(a.cancelRequested).toBe(true);
		expect(q.cancelAll()).toBe(a);
		expect(c.state).toBe("cancelled");
		q.finish(a, "cancelled", "已取消");
		expect(q.busy).toBe(false);
		expect(q.summary()).toEqual({ total: 3, done: 0, error: 0, cancelled: 3 });
	});

	it("空闲后再加入：清掉上一批的记录", () => {
		const q = new JobQueue<string>();
		const [a] = q.add(["a"]);
		if (!a) throw new Error("unreachable");
		q.start();
		q.finish(a, "error", "失败", "额度不足");
		expect(q.list()).toHaveLength(1);
		q.add(["b"]);
		expect(q.list().map((i) => i.payload)).toEqual(["b"]);
	});

	it("结束提示", () => {
		expect(summaryText({ total: 3, done: 3, error: 0, cancelled: 0 })).toBe("批量翻译结束：完成 3 篇");
		expect(summaryText({ total: 5, done: 2, error: 2, cancelled: 1 })).toBe(
			"批量翻译结束：完成 2 篇，失败 2 篇，取消 1 篇",
		);
	});
});
