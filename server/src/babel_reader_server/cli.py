"""命令行入口：serve / warmup。"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .config import ConfigError, load_config


def _setup_console_encoding() -> None:
    # 中文 Windows 控制台默认 GBK，统一改成 UTF-8，避免日志里的中文和路径乱码
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def _setup_logging(log_file: Path | None) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]
    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
    )


def _cmd_serve(args: argparse.Namespace) -> int:
    try:
        config = load_config(args.config)
    except ConfigError as e:
        print(f"配置错误：{e}", file=sys.stderr)
        return 2

    host = args.host or config.host
    port = args.port or config.port
    if host not in ("127.0.0.1", "localhost", "::1") and not config.token:
        logging.warning("服务监听在 %s 且没有设置 token，局域网内任何人都能调用", host)
    if not config.profiles:
        logging.info("config.toml 里没有 [[profiles]]，只能使用插件设置里的大模型配置")

    import uvicorn

    from .app import create_app

    app = create_app(config)
    uvicorn.run(app, host=host, port=port, log_config=None)
    return 0


def _cmd_warmup(_: argparse.Namespace) -> int:
    from . import translate

    logging.info("开始下载并校验 BabelDOC 资源（版面模型、字体等）…")
    translate.warmup()
    logging.info("warmup 完成")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="babel-reader-server", description="Babel Reader 翻译服务"
    )
    parser.add_argument("--log-file", type=Path, default=None, help="同时把日志写入该文件（UTF-8）")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="启动 HTTP 服务")
    serve.add_argument("--config", type=Path, default=Path("config.toml"), help="配置文件路径")
    serve.add_argument("--host", default=None, help="监听地址（默认读配置，配置默认 127.0.0.1）")
    serve.add_argument("--port", type=int, default=None, help="端口（默认读配置，配置默认 8891）")
    serve.set_defaults(func=_cmd_serve)

    warm = sub.add_parser("warmup", help="下载并校验版面模型和字体")
    warm.set_defaults(func=_cmd_warmup)
    return parser


def main(argv: list[str] | None = None) -> int:
    _setup_console_encoding()
    args = build_parser().parse_args(argv)
    _setup_logging(args.log_file)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
