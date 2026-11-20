import type { JobStatus } from "./types";
import { isTerminalState } from "./types";

export interface PollOptions {
	fetchStatus: () => Promise<JobStatus>;
	sleep: (ms: number) => Promise<void>;
	onUpdate?: (status: JobStatus) => void;
	/** 返回 true 时立即停止轮询 */
	isCancelled?: () => boolean;
	intervalMs?: number;
	/** 连续失败多少次后放弃（服务短暂不可达时不立刻报错） */
	maxConsecutiveErrors?: number;
}

export class PollCancelledError extends Error {
	constructor() {
		super("轮询已取消");
		this.name = "PollCancelledError";
	}
}

/** 每隔 intervalMs 查询一次任务状态，直到进入终止状态 */
export async function pollJob(opts: PollOptions): Promise<JobStatus> {
	const interval = opts.intervalMs ?? 1000;
	const maxErrors = opts.maxConsecutiveErrors ?? 5;
	let errors = 0;
	for (;;) {
		if (opts.isCancelled?.()) throw new PollCancelledError();
		let status: JobStatus | null = null;
		try {
			status = await opts.fetchStatus();
			errors = 0;
		} catch (err) {
			errors += 1;
			if (errors >= maxErrors) throw err;
		}
		if (opts.isCancelled?.()) throw new PollCancelledError();
		if (status) {
			opts.onUpdate?.(status);
			if (isTerminalState(status.state)) return status;
		}
		await opts.sleep(interval);
	}
}
