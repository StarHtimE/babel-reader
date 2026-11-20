import type { JobStatus } from "./types";

/** 状态栏上的进度文案 */
export function formatProgress(status: JobStatus): string {
	switch (status.state) {
		case "queued":
			return "排队中";
		case "running": {
			const pct = Math.floor(status.overall_progress);
			return status.stage ? `${pct}% · ${status.stage}` : `${pct}%`;
		}
		case "done":
			return "完成";
		case "error":
			return "出错";
		case "cancelled":
			return "已取消";
	}
}
