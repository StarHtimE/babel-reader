import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const prod = process.argv[2] === "production";

// 可选：从 .env 读取 OBSIDIAN_PLUGIN_DIR（Node 内置 loadEnvFile，不引第三方依赖）
if (existsSync(".env")) {
	process.loadEnvFile(".env");
}
const pluginDir = process.env.OBSIDIAN_PLUGIN_DIR?.trim() || "";

const ASSETS = ["main.js", "manifest.json", "styles.css"];

async function copyToVault() {
	if (!pluginDir) return;
	await mkdir(pluginDir, { recursive: true });
	for (const name of ASSETS) {
		if (existsSync(name)) {
			await copyFile(name, path.join(pluginDir, name));
		}
	}
	// 配合测试仓库里的 Hot Reload 插件（pjeby/hot-reload）
	await writeFile(path.join(pluginDir, ".hotreload"), "");
	console.log(`[babel-reader] 已复制到 ${pluginDir}`);
}

/** @type {esbuild.Plugin} */
const copyPlugin = {
	name: "copy-to-vault",
	setup(build) {
		build.onEnd(async (result) => {
			if (result.errors.length > 0) return;
			try {
				await copyToVault();
			} catch (err) {
				console.error("[babel-reader] 复制到插件目录失败：", err);
			}
		});
	},
};

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	format: "cjs",
	target: "es2021",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: false,
	outfile: "main.js",
	plugins: [copyPlugin],
});

if (prod) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
