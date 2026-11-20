import { describe, expect, it } from "vitest";
import { buildMultipart, escapeHeaderParam, makeBoundary } from "../src/core/multipart";

const decoder = new TextDecoder();

describe("multipart", () => {
	it("拼出符合 RFC 7578 的请求体", () => {
		const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
		const { body, contentType } = buildMultipart(
			[
				{ name: "file", filename: "source.pdf", contentType: "application/pdf", data: pdf },
				{ name: "options", value: '{"lang_out":"zh"}' },
			],
			"BOUNDARY",
		);
		expect(contentType).toBe("multipart/form-data; boundary=BOUNDARY");
		const bytes = new Uint8Array(body);
		const head =
			'--BOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="source.pdf"\r\n' +
			"Content-Type: application/pdf\r\n\r\n";
		expect(decoder.decode(bytes.slice(0, head.length))).toBe(head);
		// 二进制内容原样保留
		expect(Array.from(bytes.slice(head.length, head.length + pdf.length))).toEqual(Array.from(pdf));
		const tail =
			'\r\n--BOUNDARY\r\nContent-Disposition: form-data; name="options"\r\n\r\n' +
			'{"lang_out":"zh"}\r\n--BOUNDARY--\r\n';
		expect(decoder.decode(bytes.slice(head.length + pdf.length))).toBe(tail);
	});

	it("文本字段按 UTF-8 编码", () => {
		const { body } = buildMultipart([{ name: "options", value: "相干斑" }], "B");
		expect(decoder.decode(body)).toContain("相干斑");
	});

	it("接受 ArrayBuffer", () => {
		const buf = new Uint8Array([1, 2, 3]).buffer;
		const { body } = buildMultipart(
			[{ name: "f", filename: "a.pdf", contentType: "application/pdf", data: buf }],
			"B",
		);
		expect(body.byteLength).toBeGreaterThan(3);
	});

	it("转义参数里的引号和换行", () => {
		expect(escapeHeaderParam('a"b\r\nc')).toBe("a%22b%0D%0Ac");
	});

	it("拒绝不合法的 boundary", () => {
		expect(() => buildMultipart([], "bad boundary")).toThrow();
		expect(() => buildMultipart([], "")).toThrow();
	});

	it("makeBoundary 生成十六进制后缀", () => {
		expect(makeBoundary(new Uint8Array([0, 15, 255]))).toBe("----BabelReaderBoundary000fff");
	});
});
