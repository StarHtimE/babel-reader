import { describe, expect, it } from "vitest";
import { PollCancelledError, pollJob } from "../src/core/poll";
import type { JobStatus } from "../src/core/types";

function st(state: JobStatus["state"], overall = 0): JobStatus {
	return { state, stage: null, stage_progress: 0, overall_progress: overall };
}

const noSleep = () => Promise.resolve();

describe("pollJob", () => {
	it("轮询到终止状态为止，并回调每次进度", async () => {
		const seq = [st("queued"), st("running", 30), st("running", 80), st("done", 100)];
		const seen: number[] = [];
		const sleeps: number[] = [];
		const result = await pollJob({
			fetchStatus: () => Promise.resolve(seq.shift() ?? st("error")),
			sleep: (ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
			onUpdate: (s) => seen.push(s.overall_progress),
			intervalMs: 1000,
		});
		expect(result.state).toBe("done");
		expect(seen).toEqual([0, 30, 80, 100]);
		expect(sleeps).toEqual([1000, 1000, 1000]);
	});

	it("容忍短暂的网络错误", async () => {
		let calls = 0;
		const result = await pollJob({
			fetchStatus: () => {
				calls += 1;
				if (calls < 3) return Promise.reject(new Error("offline"));
				return Promise.resolve(st("done"));
			},
			sleep: noSleep,
			maxConsecutiveErrors: 3,
		});
		expect(result.state).toBe("done");
	});

	it("连续失败过多时抛出最后一个错误", async () => {
		await expect(
			pollJob({
				fetchStatus: () => Promise.reject(new Error("offline")),
				sleep: noSleep,
				maxConsecutiveErrors: 2,
			}),
		).rejects.toThrow("offline");
	});

	it("取消后立即停止", async () => {
		let cancelled = false;
		await expect(
			pollJob({
				fetchStatus: () => {
					cancelled = true;
					return Promise.resolve(st("running"));
				},
				sleep: noSleep,
				isCancelled: () => cancelled,
			}),
		).rejects.toBeInstanceOf(PollCancelledError);
	});
});
