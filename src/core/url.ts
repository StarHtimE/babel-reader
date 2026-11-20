export const API_PREFIX = "/v1";

/** 校验服务地址，返回去掉末尾斜杠的规范形式；不合法时返回 null */
export function normalizeServerUrl(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.search !== "" || url.hash !== "") return null;
	return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** 拼接接口地址：buildApiUrl("http://h:8891/", "/jobs/x") → "http://h:8891/v1/jobs/x" */
export function buildApiUrl(serverUrl: string, path: string): string {
	const base = normalizeServerUrl(serverUrl);
	if (base === null) throw new Error("服务地址不合法");
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `${base}${API_PREFIX}${suffix}`;
}
