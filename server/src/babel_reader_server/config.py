"""服务端配置：从 config.toml 读取。API key 只存在这里，不会发给插件。"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8891


class ConfigError(Exception):
    """配置文件缺失或内容不合法。"""


@dataclass(frozen=True)
class Profile:
    """一个 OpenAI 兼容的大模型接口配置。"""

    name: str
    base_url: str
    api_key: str
    model: str
    qps: int = 4
    temperature: str | None = None
    timeout: str | None = None
    #: 原样合并进每次 chat.completions 请求体的额外字段，
    #: 例如 DeepSeek 关闭思考：{"thinking": {"type": "disabled"}}
    extra_body: dict[str, Any] | None = field(default=None, hash=False)


@dataclass(frozen=True)
class ServerConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    token: str = ""
    #: 任务临时文件的父目录；为空则用系统临时目录
    work_dir: Path | None = None
    #: 已完成任务的结果保留多久（秒）
    result_ttl_seconds: int = 3600
    #: 上传 PDF 的大小上限（MB）
    max_upload_mb: int = 200
    profiles: tuple[Profile, ...] = field(default_factory=tuple)

    def profile_names(self) -> list[str]:
        return [p.name for p in self.profiles]

    def find_profile(self, name: str | None) -> Profile | None:
        """name 为空时返回第一个 profile。"""
        if not self.profiles:
            return None
        if not name:
            return self.profiles[0]
        for p in self.profiles:
            if p.name == name:
                return p
        return None


def _get(table: dict[str, Any], key: str, typ: type, default: Any, where: str) -> Any:
    value = table.get(key, default)
    if value is None:
        return None
    # bool 是 int 的子类，单独排除
    if typ is int and isinstance(value, bool):
        raise ConfigError(f"{where}.{key} 应为整数")
    if not isinstance(value, typ):
        raise ConfigError(f"{where}.{key} 类型应为 {typ.__name__}")
    return value


def _opt_str(table: dict[str, Any], key: str, where: str) -> str | None:
    value = table.get(key)
    if value is None or value == "":
        return None
    if isinstance(value, int | float) and not isinstance(value, bool):
        return str(value)
    if not isinstance(value, str):
        raise ConfigError(f"{where}.{key} 类型应为字符串或数字")
    return value


def _check_json_value(value: Any, where: str) -> None:
    """extra_body 会被序列化成 JSON 发给大模型接口，TOML 的日期时间等类型不允许。"""
    if isinstance(value, dict):
        for k, v in value.items():
            _check_json_value(v, f"{where}.{k}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _check_json_value(v, f"{where}[{i}]")
    elif not isinstance(value, str | int | float | bool):
        raise ConfigError(f"{where} 只能是字符串、数字、布尔、数组或表")


def _opt_table(table: dict[str, Any], key: str, where: str) -> dict[str, Any] | None:
    value = table.get(key)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ConfigError(
            f'{where}.{key} 应为表，例如 {key} = {{ thinking = {{ type = "disabled" }} }}'
        )
    _check_json_value(value, f"{where}.{key}")
    return value or None


def parse_config(data: dict[str, Any]) -> ServerConfig:
    server = data.get("server", {})
    if not isinstance(server, dict):
        raise ConfigError("[server] 应为表")

    host = _get(server, "host", str, DEFAULT_HOST, "server")
    port = _get(server, "port", int, DEFAULT_PORT, "server")
    if not 1 <= port <= 65535:
        raise ConfigError("server.port 超出范围")
    token = _get(server, "token", str, "", "server")
    work_dir_raw = _get(server, "work_dir", str, "", "server")
    ttl = _get(server, "result_ttl_seconds", int, 3600, "server")
    max_mb = _get(server, "max_upload_mb", int, 200, "server")
    if ttl < 60:
        raise ConfigError("server.result_ttl_seconds 不能小于 60")
    if max_mb < 1:
        raise ConfigError("server.max_upload_mb 不能小于 1")

    raw_profiles = data.get("profiles", [])
    if not isinstance(raw_profiles, list):
        raise ConfigError("[[profiles]] 应为数组")
    profiles: list[Profile] = []
    seen: set[str] = set()
    for i, item in enumerate(raw_profiles):
        where = f"profiles[{i}]"
        if not isinstance(item, dict):
            raise ConfigError(f"{where} 应为表")
        name = _get(item, "name", str, None, where)
        if not name:
            raise ConfigError(f"{where}.name 不能为空")
        if name in seen:
            raise ConfigError(f"profile 名称重复：{name}")
        seen.add(name)
        base_url = _get(item, "base_url", str, None, where)
        api_key = _get(item, "api_key", str, None, where)
        model = _get(item, "model", str, None, where)
        for key, value in (("base_url", base_url), ("api_key", api_key), ("model", model)):
            if not value:
                raise ConfigError(f"{where}.{key} 不能为空")
        qps = _get(item, "qps", int, 4, where)
        if qps < 1:
            raise ConfigError(f"{where}.qps 不能小于 1")
        profiles.append(
            Profile(
                name=name,
                base_url=base_url,
                api_key=api_key,
                model=model,
                qps=qps,
                temperature=_opt_str(item, "temperature", where),
                timeout=_opt_str(item, "timeout", where),
                extra_body=_opt_table(item, "extra_body", where),
            )
        )

    return ServerConfig(
        host=host,
        port=port,
        token=token,
        work_dir=Path(work_dir_raw) if work_dir_raw else None,
        result_ttl_seconds=ttl,
        max_upload_mb=max_mb,
        profiles=tuple(profiles),
    )


def load_config(path: Path) -> ServerConfig:
    if not path.is_file():
        raise ConfigError(
            f"找不到配置文件 {path}。请先复制 config.example.toml 为 config.toml 并填写。"
        )
    try:
        with path.open("rb") as f:
            data = tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"{path} 不是合法的 TOML：{e}") from e
    return parse_config(data)
