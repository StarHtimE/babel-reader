from pathlib import Path

import pytest

from babel_reader_server.config import ConfigError, load_config, parse_config


def test_defaults_and_profiles():
    cfg = parse_config(
        {
            "profiles": [
                {"name": "a", "base_url": "https://x", "api_key": "k", "model": "m"},
                {
                    "name": "b",
                    "base_url": "https://y",
                    "api_key": "k2",
                    "model": "m2",
                    "qps": 2,
                    "temperature": 0,
                },
            ]
        }
    )
    assert cfg.host == "127.0.0.1"
    assert cfg.port == 8891
    assert cfg.token == ""
    assert cfg.profile_names() == ["a", "b"]
    assert cfg.find_profile(None).name == "a"
    assert cfg.find_profile("").name == "a"
    assert cfg.find_profile("b").qps == 2
    assert cfg.find_profile("b").temperature == "0"
    assert cfg.find_profile("zzz") is None


def test_extra_body():
    base = {"name": "ds", "base_url": "u", "api_key": "k", "model": "m"}
    cfg = parse_config({"profiles": [{**base, "extra_body": {"thinking": {"type": "disabled"}}}]})
    assert cfg.find_profile("ds").extra_body == {"thinking": {"type": "disabled"}}
    # 空表等同于没配
    assert parse_config({"profiles": [{**base, "extra_body": {}}]}).profiles[0].extra_body is None
    assert parse_config({"profiles": [base]}).profiles[0].extra_body is None


@pytest.mark.parametrize(
    "extra_body",
    ["thinking=disabled", ["x"], {"when": __import__("datetime").datetime(2026, 1, 1)}],
)
def test_extra_body_invalid(extra_body):
    base = {"name": "ds", "base_url": "u", "api_key": "k", "model": "m"}
    with pytest.raises(ConfigError, match="extra_body"):
        parse_config({"profiles": [{**base, "extra_body": extra_body}]})


def test_extra_body_from_toml(tmp_path: Path):
    p = tmp_path / "c.toml"
    p.write_text(
        '[[profiles]]\nname = "ds"\nbase_url = "u"\napi_key = "k"\nmodel = "m"\n'
        'extra_body = { thinking = { type = "disabled" } }\n',
        encoding="utf-8",
    )
    assert load_config(p).profiles[0].extra_body == {"thinking": {"type": "disabled"}}


def test_no_profiles():
    cfg = parse_config({})
    assert cfg.find_profile(None) is None


@pytest.mark.parametrize(
    "data",
    [
        {"server": {"port": 0}},
        {"server": {"port": "8891"}},
        {"server": {"port": True}},
        {"profiles": [{"name": "a", "base_url": "", "api_key": "k", "model": "m"}]},
        {"profiles": [{"name": "a", "base_url": "u", "api_key": "k", "model": "m", "qps": 0}]},
        {
            "profiles": [
                {"name": "a", "base_url": "u", "api_key": "k", "model": "m"},
                {"name": "a", "base_url": "u", "api_key": "k", "model": "m"},
            ]
        },
        {"server": {"result_ttl_seconds": 1}},
    ],
)
def test_invalid(data):
    with pytest.raises(ConfigError):
        parse_config(data)


def test_load_config_file(tmp_path: Path):
    p = tmp_path / "配置 文件.toml"
    p.write_text(
        '[server]\ntoken = "t"\n'
        '[[profiles]]\nname = "中文名"\nbase_url = "u"\napi_key = "k"\nmodel = "m"\n',
        encoding="utf-8",
    )
    cfg = load_config(p)
    assert cfg.token == "t"
    assert cfg.profile_names() == ["中文名"]


def test_missing_file(tmp_path: Path):
    with pytest.raises(ConfigError, match="config.example.toml"):
        load_config(tmp_path / "nope.toml")


def test_bad_toml(tmp_path: Path):
    p = tmp_path / "c.toml"
    p.write_text("[server\n", encoding="utf-8")
    with pytest.raises(ConfigError):
        load_config(p)


def test_example_config_is_valid():
    example = Path(__file__).resolve().parent.parent / "config.example.toml"
    cfg = load_config(example)
    assert cfg.profile_names() == ["deepseek"]
