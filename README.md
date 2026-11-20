# Babel Reader

> 在 Obsidian 里一键生成保留排版的 PDF 译文，并在「原文 / 译文 / 对照」之间切换，切换后停在同一页。

**状态：v0.1.0**，可从 [Releases](https://github.com/StarHtimE/babel-reader/releases) 下载。尚未上架 Obsidian 社区插件目录，需要手动安装（见「安装」）。只在 Windows 桌面端测试过。

## 它做什么

- 对仓库里的 PDF 一键翻译，输出两份 PDF：
  - **译文**：保留原排版、公式和图表，只把文字换成目标语言
  - **对照**：原文和译文左右并排在同一页
- 在 PDF 视图顶部切换 **原文 / 译文 / 对照**，切换后停在同一页（三份文件的第 N 页始终是同一内容）
- 原文是唯一正本：插件从不修改原文，笔记里的链接、反链、高亮都指向原文；译文只写进单独的译文目录
- 翻译引擎是 [BabelDOC](https://github.com/funstory-ai/BabelDOC)，通过 [PDFMathTranslate-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next)（pdf2zh_next）调用，大模型用任意 OpenAI 兼容接口（如 DeepSeek）

## 工作方式

插件本身不做翻译。翻译由一个单独运行的本地服务完成，代码在本项目的 `server/` 目录：

```
Obsidian 插件 ──HTTP──▶ Babel Reader Server ──▶ pdf2zh_next / BabelDOC ──▶ 你配置的大模型 API
      ▲                                                     │
      └──────────── 译文 PDF（mono / dual）◀────────────────┘
```

- 插件把 PDF 上传给服务、每秒查询一次进度，完成后把译文写回仓库
- 点击翻译时如果服务没在运行，插件会在后台自动启动它（桌面端，可在设置里关闭）；也可以自己手动启动
- 服务默认只监听本机 `127.0.0.1`
- 大模型的 API key 只保存在服务端的 `config.toml` 里，不进入 Obsidian 仓库，也不会随仓库同步

## 环境要求

- **Obsidian** 1.6 或更高版本（桌面端）
- **翻译服务**：[uv](https://docs.astral.sh/uv/)（会自动下载所需的 Python 3.12，不用单独装 Python）；首次运行需要下载约 300 MB 的版面模型和字体
- **[Git](https://git-scm.com/)**：用来下载和更新服务端源码（也可以直接下载源码压缩包）
- **一个 OpenAI 兼容的大模型 API**，如 DeepSeek，或本地运行的 OpenAI 兼容服务

安装 uv：

```powershell
# Windows
winget install astral-sh.uv
```

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## 安装

### 1. 下载源码

翻译服务没有单独的安装包，需要源码里的 `server/` 目录：

```bash
git clone https://github.com/StarHtimE/babel-reader.git
cd babel-reader
```

也可以在 [Releases](https://github.com/StarHtimE/babel-reader/releases) 下载对应版本的「Source code (zip)」解压。用 Git 的好处是以后 `git pull` 就能更新。

### 2. 安装翻译服务

```bash
cd server
uv sync                              # 安装依赖（首次较慢）
cp config.example.toml config.toml   # 然后编辑 config.toml，填入 API key、接口地址和模型
uv run babel-reader-server warmup    # 只需一次：下载并校验版面模型和字体
```

- `warmup` 只需要跑一次。跳过的话，第一次翻译会先下载模型，看起来像卡住了
- 服务不用手动启动：在插件设置里填好「服务目录」（第 4 步）后，点翻译时插件会自动在后台启动它
- 想手动启动（比如不用自动启动，或想看实时输出）：`uv run babel-reader-server serve`，默认监听 `127.0.0.1:8891`，翻译期间不要关掉这个终端

`config.toml` 最少需要一个 profile：

```toml
[server]
host = "127.0.0.1"
port = 8891
token = ""            # 访问令牌；只在本机使用时可留空

[[profiles]]
name = "deepseek"
base_url = "https://api.deepseek.com"
api_key = "sk-..."
model = "deepseek-chat"
qps = 4
extra_body = { thinking = { type = "disabled" } }   # 关闭思考，见下
```

**关于思考模式：** 默认开启思考的模型（如 DeepSeek）会先推理每一段再翻译，速度会慢很多倍。实测一篇 17 页的论文，开着思考约 23 分钟，用上面的 `extra_body` 关掉后约 2 分钟。其他服务商关闭思考的字段名不同，请按其文档填写。完整的配置项见下文「服务端配置参考」。

### 3. 安装插件

任选一种：

**手动安装**

1. 从 [最新 Release](https://github.com/StarHtimE/babel-reader/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css` 三个文件
2. 在你的仓库里新建文件夹 `<仓库>/.obsidian/plugins/babel-reader/`（文件夹名必须是 `babel-reader`），把三个文件放进去
3. 在 Obsidian 的「设置 → 第三方插件」里关闭「安全模式」（新版本叫「受限模式」），刷新插件列表，启用 **Babel Reader**

**用 BRAT 安装**（以后可以自动更新）

装好社区插件 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 后，运行命令「BRAT: Add a beta plugin for testing」，填入 `StarHtimE/babel-reader`，再在「第三方插件」里启用 **Babel Reader**。

**从源码构建**（需要 [Node.js](https://nodejs.org/) 22 或更高版本）：在项目根目录运行 `npm install` 和 `npm run build`，生成的 `main.js` 和 `manifest.json`、`styles.css` 一起按手动安装的第 2、3 步放进插件文件夹。

插件不会安装或更新翻译服务及其依赖，服务需要按第 2 步自行安装。

### 4. 连接服务

打开「设置 → Babel Reader」：

1. 「服务目录」填 `server` 文件夹的完整路径，如 `D:\babel-reader\server`，点「检查」确认找得到服务程序和 `config.toml`
2. 确认服务地址是 `http://127.0.0.1:8891`
3. 第一次翻译时插件会自动启动服务。之后可以点「测试连接」（它不会启动服务），成功时显示服务和引擎的版本号；再点「翻译配置」旁边的刷新按钮，选择 `config.toml` 里的 profile（留空则用第一个）

## 使用

### 翻译

打开一个 PDF，点视图顶部的 **翻译** 按钮（语言图标），或运行命令「翻译当前 PDF」。

- 服务没在运行时，状态栏先显示「启动翻译服务…」，通常几秒钟
- 状态栏显示进度和当前阶段；**点击状态栏**（或运行命令「取消翻译」）可以取消
- 同一时间只能翻译一篇
- 完成后译文写入译文目录（默认 `_translations/`），原文不会被改动

### 切换

已有译文的 PDF，视图顶部会出现四个按钮：

| 按钮 | 作用 |
|---|---|
| 文件图标 | 切换到原文 |
| 语言图标 | 切换到译文 |
| 书本图标 | 切换到对照（左右并排） |
| 刷新图标 | 重新翻译当前 PDF（只在原文上出现） |

切换时停在当前页。直接打开译文文件，也会显示这组切换按钮。三条切换命令「切换到原文 / 译文 / 对照」可以在「设置 → 快捷键」里绑定快捷键。

### 重新翻译与删除

- **重新翻译** 会覆盖同一目录里的译文。参数相同时会复用服务端的翻译缓存，所以很快
- **删除译文**：直接删除 `_translations/` 下对应的文件夹即可，按钮会立即恢复成「翻译」

## 设置

设置 → Babel Reader：

| 选项 | 说明 | 默认值 |
|---|---|---|
| 服务地址 | 翻译服务的 URL，旁边有「测试连接」按钮 | `http://127.0.0.1:8891` |
| 访问令牌 | 与服务端 `token` 一致；服务端没设令牌时留空 | 空 |
| 自动启动服务 | 点翻译时连不上本机服务就在后台启动它（仅桌面端、仅本机地址） | 开 |
| 服务目录 | `server` 文件夹的完整路径；旁边有「检查」按钮 | 空 |
| 翻译配置 | 对应 `config.toml` 里的 profile，可从服务端读取 | 服务端第一个 |
| 源语言 / 目标语言 | 语言代码 | `en` → `zh` |
| 生成对照版 | 关闭则只生成译文 | 开 |
| 对照版译文在左 | 只影响对照版左右顺序，不影响页码 | 关 |
| 译文目录 | 译文和清单的存放位置（仓库内路径），修改后会重新扫描 | `_translations` |

## 文件布局

```
_translations/
└── <原文文件名>-<6 位短 ID>/
    ├── <原文文件名>.zh.mono.pdf   # 译文
    ├── <原文文件名>.zh.dual.pdf   # 对照
    └── manifest.json             # 原文路径、哈希、翻译参数、引擎版本
```

每篇论文会多出两份 PDF。如果仓库跨设备同步，可以关闭「生成对照版」，或者在同步工具里排除 `_translations/`。

## 服务端配置参考

`server/config.toml`（已在 `.gitignore` 中，不会被提交）：

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `[server] host` | 监听地址 | `127.0.0.1` |
| `[server] port` | 端口 | `8891` |
| `[server] token` | 访问令牌；设置后插件必须填写相同的令牌 | 空 |
| `[server] work_dir` | 任务临时文件的位置 | 系统临时目录 |
| `[server] result_ttl_seconds` | 已完成任务的结果在服务端保留多久 | `3600` |
| `[server] max_upload_mb` | 上传 PDF 的大小上限 | `200` |
| `[[profiles]] name` | 名称，插件按它选择 | 必填 |
| `[[profiles]] base_url` / `api_key` / `model` | OpenAI 兼容接口的地址、密钥、模型 | 必填 |
| `[[profiles]] qps` | 每秒请求数上限 | `4` |
| `[[profiles]] temperature` / `timeout` | 可选，填了才会发送 | 不发送 |
| `[[profiles]] extra_body` | 原样合并进每次请求体的额外字段，如关闭思考 | 不发送 |

修改 `extra_body`、`model` 等参数后，之前翻译过的段落不会命中翻译缓存，会重新调用大模型。

命令行：

```bash
uv run babel-reader-server serve [--config 路径] [--host 地址] [--port 端口]
uv run babel-reader-server --log-file server.log serve   # 同时把日志写入文件（UTF-8）
uv run babel-reader-server warmup
```

## 常见问题

- **「测试连接」失败**：「测试连接」不会自动启动服务，服务没在运行时失败是正常的，点一次翻译即可启动；否则确认地址和端口正确，服务端设置了 `token` 时插件里要填相同的访问令牌
- **自动启动失败**：提示里有原因和最后几行输出；完整日志在服务目录的 `server.log`。常见原因是没运行 `uv sync`、没有 `config.toml`，或端口被其他程序占用
- **自动启动提示「No Python at …」（退出码 103）**：虚拟环境指向的 Python 不存在。常见于在 Claude 桌面版等打包应用（MSIX）的终端里运行过 `uv`：Windows 会把它写进 `AppData` 的文件重定向到该应用的私有目录，其他程序看不到。在普通的 PowerShell 里进入 `server` 目录重新运行 `uv python install 3.12` 和 `uv sync` 即可
- **翻译很慢**：多半是模型开着思考模式，见上文 `extra_body`；也可以适当调高 `qps`（注意服务商的限流）
- **第一次翻译好像卡住了**：没有运行 `warmup`，服务正在下载版面模型，等它下载完即可
- **翻译失败**：弹出的提示里有服务端返回的原因（如 API key 无效、额度不足）；更详细的信息看服务端终端输出或 `--log-file` 指定的日志

## 更新

插件和服务端分开更新，最好保持同一版本：

- **插件**：从 [最新 Release](https://github.com/StarHtimE/babel-reader/releases/latest) 下载三个文件覆盖插件文件夹里的旧文件，然后在 Obsidian 里重新启用插件；用 BRAT 安装的会自动更新
- **服务端**：先关闭 Obsidian（正在运行的服务会占用虚拟环境里的文件），再在项目根目录运行：

```bash
git pull
cd server
uv sync
```

自动启动的服务会一直运行到关闭 Obsidian，所以更新服务端后重新打开 Obsidian 即可用上新版本。

## 已知限制（v0.1）

- 原文被重命名或移动后，插件找不到它和译文的关联，需要重新翻译（重命名跟踪在 v0.2）
- 原文内容变化后不会提示译文过期（v0.2）
- 还不支持术语表、只翻译指定页、批量翻译（v0.2）
- 插件只结束自己启动的服务。手动启动的服务、以及 Obsidian 异常退出后残留的服务不会被关闭，下次翻译会直接连上它继续用
- 只在 Windows 桌面端测试过；移动端可以阅读已同步的译文，但手机连不到电脑上的本地服务，无法发起翻译（局域网服务在 v0.3）

## 隐私与网络

- 插件只连接你在设置里填写的翻译服务地址，不连接任何其他服务器，不收集遥测数据
- 翻译服务会把 PDF 里的文本发送给你在 `config.toml` 里配置的大模型服务商，请确认这符合你对文献内容的保密要求
- 插件只读写仓库内的文件：原文（只读）和译文目录
- **仓库外的文件与外部程序**（只在开启「自动启动服务」时，仅桌面端）：插件会检查「服务目录」里的服务程序和 `config.toml` 是否存在（不读取内容），并运行 `<服务目录>/.venv` 里已安装的 `babel-reader-server`，日志写入该目录的 `server.log`。插件不运行 uv / pip，不安装或更新任何程序

## 路线图

- [x] v0.1：单篇翻译、进度与取消、三态切换（保持页码）、清单、按需自动启动服务
- [ ] v0.2：右键批量翻译与队列、过期检测、重命名/删除跟踪、术语表、指定页翻译
- [ ] v0.3：原文与译文双栏同步滚动、移动端裁剪阅读、局域网远程服务

## 许可证

- 插件（项目根目录）：MIT，见 [LICENSE](LICENSE)
- 翻译服务（`server/`）：AGPL-3.0，见 [server/LICENSE](server/LICENSE)，因为它依赖同为 AGPL-3.0 的 BabelDOC 和 PDFMathTranslate-next

## 致谢

- [BabelDOC](https://github.com/funstory-ai/BabelDOC)、[PDFMathTranslate-next](https://github.com/PDFMathTranslate/PDFMathTranslate-next)：翻译引擎
- [zotero-pdf2zh](https://github.com/guaguastandup/zotero-pdf2zh)：「插件 + 本地服务」结构的先例
- [PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus)：扩展 Obsidian PDF 视图的参考
