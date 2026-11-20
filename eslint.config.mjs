import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	// 构建产物、Node 构建脚本和 Python 服务端都不是插件代码
	globalIgnores([
		"node_modules",
		"main.js",
		"esbuild.config.mjs",
		"vitest.config.mjs",
		"server",
	]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.*"],
				},
			},
		},
	},
]);
