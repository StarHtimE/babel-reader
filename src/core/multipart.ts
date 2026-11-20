/**
 * 手动构造 multipart/form-data 请求体。
 * Obsidian 的 requestUrl 不会替我们拼 multipart，只能自己按 RFC 7578 组装字节。
 */

export interface MultipartTextField {
	name: string;
	value: string;
}

export interface MultipartFileField {
	name: string;
	filename: string;
	contentType: string;
	data: ArrayBuffer | Uint8Array;
}

export type MultipartField = MultipartTextField | MultipartFileField;

export interface MultipartBody {
	body: ArrayBuffer;
	contentType: string;
}

const CRLF = "\r\n";

/** 按 WHATWG 的做法转义头部参数里的引号和换行 */
export function escapeHeaderParam(value: string): string {
	return value.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function makeBoundary(randomBytes: Uint8Array): string {
	let hex = "";
	for (const b of randomBytes) hex += b.toString(16).padStart(2, "0");
	return `----BabelReaderBoundary${hex}`;
}

function isFileField(field: MultipartField): field is MultipartFileField {
	return "data" in field;
}

export function buildMultipart(fields: readonly MultipartField[], boundary: string): MultipartBody {
	if (!/^[0-9A-Za-z'()+_,\-./:=?]{1,70}$/.test(boundary)) {
		throw new Error("multipart boundary 不合法");
	}
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];

	for (const field of fields) {
		let head = `--${boundary}${CRLF}`;
		head += `Content-Disposition: form-data; name="${escapeHeaderParam(field.name)}"`;
		if (isFileField(field)) {
			head += `; filename="${escapeHeaderParam(field.filename)}"${CRLF}`;
			head += `Content-Type: ${field.contentType}${CRLF}${CRLF}`;
			chunks.push(encoder.encode(head));
			chunks.push(field.data instanceof Uint8Array ? field.data : new Uint8Array(field.data));
		} else {
			head += `${CRLF}${CRLF}`;
			chunks.push(encoder.encode(head));
			chunks.push(encoder.encode(field.value));
		}
		chunks.push(encoder.encode(CRLF));
	}
	chunks.push(encoder.encode(`--${boundary}--${CRLF}`));

	const total = chunks.reduce((n, c) => n + c.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return {
		body: out.buffer,
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}
