# Babel Reader

> 在 Obsidian 里一键生成保留排版的 PDF 译文，并在「原文 / 译文 / 对照」之间切换。

**状态：开发中，v0.1 尚未发布。** 下文的功能以「路线图」一节为准。

## 它做什么

- 对仓库里的任意 PDF 一键翻译，输出两份 PDF：
  - **译文**：保留原排版、公式和图表，只把文字换成目标语言
  - **对照**：原文和译文左右并排在同一页
- 在 PDF 视图顶部一键切换 **原文 / 译文 / 对照**，切换后停在同一页
- 原文是唯一正本：笔记里的链接、反链、高亮都指向原文，译文文件不进入链接体系
- 用一篇笔记（或现成的 CSV）维护术语表，翻译时自动带上，保证领域术语前后一致
- 翻译引擎是 [BabelDOC](https://github.com/funstory-ai/BabelDOC)，通过 [PDFMathTranslate-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next)（pdf2zh_next）调用

## 工作方式

插件本身不做翻译。翻译由一个单独运行的本地服务完成，代码在本项目的 `server/` 目录：

```
Obsidian 插件 ──HTTP──▶ Babel Reader Server ──▶ pdf2zh_next / BabelDOC ──▶ 你配置的大模型 API
      ▲                                                     │
      └──────────── 译文 PDF（mono / dual）◀────────────────┘
```

- 插件把 PDF 上传给服务、轮询进度，完成后把译文写回仓库
- 服务默认跑在本机；设计上也可以跑在局域网里的另一台机器上（v0.3），届时手机和平板也能发起翻译
- 大模型的 API key 只保存在服务端配置里，不进入 Obsidian 仓库，也不会随仓库同步

## 环境要求

- Obsidian 桌面端或移动端：阅读和切换在所有平台可用；发起翻译需要能连到服务
- 服务端：Python 3.12、[uv](https://docs.astral.sh/uv/)
- 一个 OpenAI 兼容的大模型 API（如 DeepSeek），或本地运行的 OpenAI 兼容服务

## 安装

### 1. 翻译服务

```bash
git clone https://github.com/StarHtimE/babel-reader.git
cd babel-reader/server
uv sync
cp config.example.toml config.toml   # 填入 API key、接口地址和模型
uv run babel-reader-server warmup    # 首次运行：下载并校验版面模型和字体
uv run babel-reader-server serve     # 默认监听 127.0.0.1:8891
```

`warmup` 只需要跑一次。跳过的话，第一次翻译会先下载模型，看起来像卡住了。

`config.toml` 示例：

```toml
[server]
host = "127.0.0.1"
port = 8891
token = ""            # 开放到局域网时务必设置

[[profiles]]
name = "deepseek"
base_url = "https://api.deepseek.com"
api_key = "sk-..."
model = "deepseek-chat"
qps = 4
extra_body = { thinking = { type = "disabled" } }   # 可选，见下
```

- `extra_body`：原样合并进每次请求体的额外字段。默认开启思考的模型（如 DeepSeek）每段都会先推理，翻译会慢很多，用上面这行关掉；其他服务商关闭思考的字段名不同，按其文档填写。修改后已翻译过的段落不会命中翻译缓存
- `temperature`、`timeout`：可选，填了才会发送

### 2. 插件

尚未上架社区目录。手动安装：从 Releases 下载 `main.js`、`manifest.json`、`styles.css`，放进 `<仓库>/.obsidian/plugins/babel-reader/`，重启 Obsidian 后在「第三方插件」中启用。

插件不会自动安装或更新翻译服务及其依赖，服务需要按上一步自行安装。

## 配置

设置 → Babel Reader：

| 选项 | 说明 | 默认值 |
|---|---|---|
| 服务地址 | 翻译服务的 URL，旁边有「测试连接」按钮 | `http://127.0.0.1:8891` |
| 访问令牌 | 与服务端 `token` 一致；仅本机使用时可留空 | 空 |
| 源语言 / 目标语言 | | `en` → `zh` |
| 翻译配置 | 从服务端读取，对应 `config.toml` 里的 profile | 第一个 |
| 译文目录 | 译文和清单的存放位置 | `_translations` |
| 生成对照版 | 关闭则只生成译文 | 开 |
| 术语表 | 一篇笔记或一个 CSV 文件，见下文 | 空 |

## 使用

- **翻译**：打开 PDF，点视图顶部的「翻译」按钮，或运行命令「翻译当前 PDF」。进度显示在状态栏，可随时取消
- **切换**：已有译文的 PDF，视图顶部会出现「原文 / 译文 / 对照」按钮；也可以给三条切换命令绑快捷键
- **部分翻译**：命令「翻译指定页」只翻译选定页（比如跳过参考文献和附录）；未翻译的页保留原文，页码不变
- **重新翻译**：默认复用翻译缓存；「强制重新翻译」会忽略缓存

### 术语表

在设置里指定一篇笔记，内容是一个两列表格：

| source | target |
|---|---|
| speckle | 相干斑 |
| backscatter | 后向散射 |

也可以直接指定仓库里现成的 CSV 文件（`source,target` 两列）。每次翻译时插件把术语表交给 BabelDOC；翻译中自动抽取到的新术语可以写回笔记，供你审核后保留。

## 文件布局

```
_translations/
└── <原文文件名>-<短 ID>/
    ├── <原文文件名>.zh.mono.pdf   # 译文
    ├── <原文文件名>.zh.dual.pdf   # 对照
    └── manifest.json             # 原文路径、哈希、翻译参数、引擎版本
```

- 原文被修改后（哈希变化），插件会把译文标记为过期，不会自动重译
- 原文重命名或移动时，清单跟着更新；原文删除时，插件会询问是否一并删除译文
- 每篇论文会多出两份 PDF。如果仓库跨设备同步，可以只生成译文，或者在同步工具里排除 `_translations/`

## 隐私与网络

- 插件只连接你在设置里填写的翻译服务地址，不连接任何其他服务器，不收集遥测数据
- 翻译服务会把 PDF 里的文本发送给你在 `config.toml` 里配置的大模型服务商，请确认这符合你对文献内容的保密要求
- 插件只读写仓库内的文件：原文（只读）和译文目录

## 路线图

- [ ] v0.1：单篇翻译、进度与取消、三态切换（保持页码）、清单
- [ ] v0.2：右键批量翻译与队列、过期检测、重命名/删除跟踪、术语表
- [ ] v0.3：原文与译文双栏同步滚动、移动端裁剪阅读、局域网远程服务

## 许可证

- 插件（项目根目录）：MIT
- 翻译服务（`server/`）：AGPL-3.0，因为它依赖同为 AGPL-3.0 的 BabelDOC 和 PDFMathTranslate-next

## 致谢

- [BabelDOC](https://github.com/funstory-ai/BabelDOC)、[PDFMathTranslate-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next)：翻译引擎
- [zotero-pdf2zh](https://github.com/guaguastandup/zotero-pdf2zh)：「插件 + 本地服务」结构的先例
- [PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus)：扩展 Obsidian PDF 视图的参考
