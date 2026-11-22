"""HTTP 接口测试：用假的翻译函数，不调用 pdf2zh_next。"""

import asyncio
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from babel_reader_server.app import create_app
from babel_reader_server.config import Profile, ServerConfig

PDF = b"%PDF-1.7\n%fake\n"
PROFILES = (
    Profile(name="deepseek", base_url="https://x", api_key="sk-secret", model="m"),
    Profile(name="local", base_url="http://127.0.0.1:1234", api_key="k", model="m2"),
)


class FakeTranslator:
    """模拟翻译：报告进度，写出结果文件。hang=True 时一直等到被取消。"""

    def __init__(self, *, hang: bool = False, fail: str | None = None):
        self.hang = hang
        self.fail = fail
        self.calls: list[dict] = []
        self.cancelled = False

    async def __call__(self, input_path, output_dir, options, profile, on_progress, glossary_path):
        self.calls.append(
            {
                "input": input_path.read_bytes(),
                "options": options,
                "profile": profile.name,
                "profile_obj": profile,
                "glossary": glossary_path.read_text(encoding="utf-8") if glossary_path else None,
            }
        )
        on_progress("Parse PDF", 50.0, 20.0)
        if self.hang:
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                self.cancelled = True
                raise
        if self.fail:
            raise RuntimeError(self.fail)
        out = {}
        for kind in options.outputs:
            p = Path(output_dir) / f"source.{options.lang_out}.{kind}.pdf"
            p.write_bytes(PDF + kind.encode())
            out[kind] = p
        return out


def make_client(tmp_path, translator, profiles=PROFILES, **cfg):
    config = ServerConfig(work_dir=tmp_path / "work", profiles=profiles, **cfg)
    app = create_app(config, translator=translator, versions=lambda: ("2.10.2", "0.7.1"))
    return TestClient(app)


def submit(client, options=None, data=PDF, headers=None):
    return client.post(
        "/v1/jobs",
        files={"file": ("论文 a.pdf", data, "application/pdf")},
        data={"options": json.dumps(options if options is not None else {"lang_out": "zh"})},
        headers=headers or {},
    )


def wait_state(client, job_id, states, timeout=5.0, headers=None):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        st = client.get(f"/v1/jobs/{job_id}", headers=headers or {}).json()
        if st["state"] in states:
            return st
        time.sleep(0.02)
    raise AssertionError(f"任务没有进入 {states}，最后状态 {st}")


def test_health_and_profiles(tmp_path):
    with make_client(tmp_path, FakeTranslator()) as c:
        h = c.get("/v1/health").json()
        assert h == {
            "ok": True,
            "server_version": "0.2.0",
            "pdf2zh_next_version": "2.10.2",
            "babeldoc_version": "0.7.1",
            "features": ["llm", "glossary"],
        }
        p = c.get("/v1/profiles").json()
        assert p == {"profiles": ["deepseek", "local"]}
        # 不泄露 key
        assert "sk-secret" not in json.dumps(p)


def test_full_job_flow(tmp_path):
    fake = FakeTranslator()
    with make_client(tmp_path, fake) as c:
        r = submit(
            c,
            {
                "lang_in": "en",
                "lang_out": "zh",
                "profile": "local",
                "outputs": ["mono", "dual"],
                "glossary_csv": "source,target\nspeckle,相干斑\n",
                "future_field": 1,
            },
        )
        assert r.status_code == 200, r.text
        job_id = r.json()["job_id"]

        st = wait_state(c, job_id, {"done"})
        assert st["outputs"] == ["mono", "dual"]
        assert st["overall_progress"] == 100

        assert fake.calls[0]["input"] == PDF
        assert fake.calls[0]["profile"] == "local"
        assert "相干斑" in fake.calls[0]["glossary"]

        mono = c.get(f"/v1/jobs/{job_id}/files/mono")
        assert mono.status_code == 200
        assert mono.headers["content-type"] == "application/pdf"
        assert mono.content == PDF + b"mono"
        assert c.get(f"/v1/jobs/{job_id}/files/dual").content == PDF + b"dual"
        assert c.get(f"/v1/jobs/{job_id}/files/epub").status_code == 404


def test_mono_only(tmp_path):
    with make_client(tmp_path, FakeTranslator()) as c:
        job_id = submit(c, {"outputs": ["mono"]}).json()["job_id"]
        st = wait_state(c, job_id, {"done"})
        assert st["outputs"] == ["mono"]
        assert c.get(f"/v1/jobs/{job_id}/files/dual").status_code == 404


def test_default_profile_is_first(tmp_path):
    fake = FakeTranslator()
    with make_client(tmp_path, fake) as c:
        job_id = submit(c, {"profile": None}).json()["job_id"]
        wait_state(c, job_id, {"done"})
        assert fake.calls[0]["profile"] == "deepseek"


def test_error_state(tmp_path):
    with make_client(tmp_path, FakeTranslator(fail="额度不足")) as c:
        job_id = submit(c).json()["job_id"]
        st = wait_state(c, job_id, {"error"})
        assert st["error"] == "额度不足"
        assert c.get(f"/v1/jobs/{job_id}/files/mono").status_code == 409


def test_cancel_running_job(tmp_path):
    fake = FakeTranslator(hang=True)
    with make_client(tmp_path, fake) as c:
        job_id = submit(c).json()["job_id"]
        st = wait_state(c, job_id, {"running"})
        assert st["stage"] == "Parse PDF"
        r = c.delete(f"/v1/jobs/{job_id}")
        assert r.status_code == 200
        assert r.json()["state"] == "cancelled"
        deadline = time.monotonic() + 5
        while not fake.cancelled and time.monotonic() < deadline:
            time.sleep(0.02)
        assert fake.cancelled
        assert c.get(f"/v1/jobs/{job_id}").json()["state"] == "cancelled"


def test_jobs_run_serially_and_queued_cancel(tmp_path):
    fake = FakeTranslator(hang=True)
    with make_client(tmp_path, fake) as c:
        first = submit(c).json()["job_id"]
        wait_state(c, first, {"running"})
        second = submit(c).json()["job_id"]
        assert c.get(f"/v1/jobs/{second}").json()["state"] == "queued"
        # 取消排队中的任务：不会开始执行
        assert c.delete(f"/v1/jobs/{second}").json()["state"] == "cancelled"
        c.delete(f"/v1/jobs/{first}")
        time.sleep(0.1)
        assert len(fake.calls) == 1


def test_validation_errors(tmp_path):
    with make_client(tmp_path, FakeTranslator()) as c:
        assert submit(c, data=b"not a pdf").status_code == 400
        assert submit(c, {"profile": "nope"}).status_code == 400
        assert submit(c, {"outputs": []}).status_code == 400
        assert submit(c, {"outputs": ["epub"]}).status_code == 400
        assert submit(c, {"lang_out": "../x"}).status_code == 400
        assert submit(c, {"pages": "1;rm"}).status_code == 400
        bad = c.post(
            "/v1/jobs", files={"file": ("a.pdf", PDF, "application/pdf")}, data={"options": "{"}
        )
        assert bad.status_code == 400
        assert "JSON" in bad.json()["detail"]
        assert c.get("/v1/jobs/unknown").status_code == 404
        assert c.delete("/v1/jobs/unknown").status_code == 404


def test_upload_size_limit(tmp_path):
    with make_client(tmp_path, FakeTranslator(), max_upload_mb=1) as c:
        big = PDF + b"0" * (1024 * 1024 + 10)
        assert submit(c, data=big).status_code == 413


def test_token_required(tmp_path):
    with make_client(tmp_path, FakeTranslator(), token="s3cret") as c:
        assert c.get("/v1/health").status_code == 401
        assert c.get("/v1/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
        ok = {"Authorization": "Bearer s3cret"}
        assert c.get("/v1/health", headers=ok).status_code == 200
        assert submit(c).status_code == 401
        job_id = submit(c, headers=ok).json()["job_id"]
        wait_state(c, job_id, {"done"}, headers=ok)


@pytest.mark.parametrize("pages,expected", [("1-3, 5", "1-3,5"), ("", None), (None, None)])
def test_pages_normalized(tmp_path, pages, expected):
    fake = FakeTranslator()
    with make_client(tmp_path, fake) as c:
        job_id = submit(c, {"pages": pages}).json()["job_id"]
        wait_state(c, job_id, {"done"})
        assert fake.calls[0]["options"].pages == expected


def test_purge_expired(tmp_path):
    with make_client(tmp_path, FakeTranslator()) as c:
        job_id = submit(c).json()["job_id"]
        wait_state(c, job_id, {"done"})
        manager = c.app.state.manager
        job = manager.get(job_id)
        work_dir = job.work_dir
        assert work_dir.exists()
        assert manager.purge_expired(now=time.time() + 10) == 0
        assert manager.purge_expired(now=time.time() + 7200) == 1
        assert not work_dir.exists()
        assert c.get(f"/v1/jobs/{job_id}").status_code == 404


LLM = {
    "name": "我的 DeepSeek",
    "base_url": "https://api.example.com/v1",
    "api_key": "sk-from-plugin",
    "model": "m-plugin",
    "qps": 8,
    "temperature": "0.3",
    "timeout": "60",
    "extra_body": {"thinking": {"type": "disabled"}},
}


def test_plugin_llm_overrides_server_profile(tmp_path, caplog):
    fake = FakeTranslator()
    caplog.set_level("DEBUG")
    with make_client(tmp_path, fake) as c:
        r = submit(c, {"profile": "local", "llm": LLM})
        assert r.status_code == 200, r.text
        job_id = r.json()["job_id"]
        st = wait_state(c, job_id, {"done"})

        used = fake.calls[0]["profile_obj"]
        assert used.name == "我的 DeepSeek"
        assert used.base_url == "https://api.example.com/v1"
        assert used.api_key == "sk-from-plugin"
        assert used.model == "m-plugin"
        assert used.qps == 8
        assert used.temperature == "0.3"
        assert used.timeout == "60"
        assert used.extra_body == {"thinking": {"type": "disabled"}}
        # 交给翻译函数的 options 里不再带密钥
        assert fake.calls[0]["options"].llm is None
        # 状态和日志里都没有密钥明文
        assert "sk-from-plugin" not in json.dumps(st)
        assert "sk-from-plugin" not in caplog.text


def test_plugin_llm_without_server_profiles(tmp_path):
    fake = FakeTranslator()
    with make_client(tmp_path, fake, profiles=()) as c:
        assert c.get("/v1/profiles").json() == {"profiles": []}
        r = submit(c, {"lang_out": "zh"})
        assert r.status_code == 400
        assert "插件设置" in r.json()["detail"]

        r = submit(c, {"llm": {k: LLM[k] for k in ("base_url", "api_key", "model")}})
        assert r.status_code == 200, r.text
        wait_state(c, r.json()["job_id"], {"done"})
        used = fake.calls[0]["profile_obj"]
        assert used.name == "plugin"
        assert used.qps == 4
        assert used.temperature is None
        assert used.extra_body is None


@pytest.mark.parametrize(
    "patch",
    [
        {"base_url": "ftp://x"},
        {"base_url": ""},
        {"api_key": ""},
        {"model": ""},
        {"qps": 0},
        {"temperature": "warm"},
        {"timeout": "-1"},
        {"extra_body": [1, 2]},
    ],
)
def test_plugin_llm_validation(tmp_path, patch):
    with make_client(tmp_path, FakeTranslator()) as c:
        r = submit(c, {"llm": {**LLM, **patch}})
        assert r.status_code == 400
        assert r.json()["detail"].startswith("options.llm.")
        # 校验错误里也不回显密钥
        assert "sk-from-plugin" not in r.text


class GlossaryTranslator(FakeTranslator):
    """在 PDF 之外还返回自动抽取的术语"""

    async def __call__(self, input_path, output_dir, options, profile, on_progress, glossary_path):
        out = await super().__call__(
            input_path, output_dir, options, profile, on_progress, glossary_path
        )
        g = Path(output_dir) / "source.zh.glossary.csv"
        g.write_text("source,target,tgt_lng\nspeckle,相干斑,zh\n", encoding="utf-8-sig")
        out["glossary"] = g
        return out


def test_auto_extracted_glossary_is_downloadable(tmp_path):
    fake = GlossaryTranslator()
    with make_client(tmp_path, fake) as c:
        assert "glossary" in c.get("/v1/health").json()["features"]
        job_id = submit(c, {"auto_extract_glossary": True}).json()["job_id"]
        st = wait_state(c, job_id, {"done"})
        # PDF 种类不变，术语单独列在 extras 里
        assert st["outputs"] == ["mono", "dual"]
        assert st["extras"] == ["glossary"]
        assert fake.calls[0]["options"].auto_extract_glossary is True
        r = c.get(f"/v1/jobs/{job_id}/files/glossary")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/csv")
        assert "相干斑" in r.content.decode("utf-8-sig")


def test_no_extras_without_glossary(tmp_path):
    with make_client(tmp_path, FakeTranslator()) as c:
        job_id = submit(c, {"auto_extract_glossary": False}).json()["job_id"]
        st = wait_state(c, job_id, {"done"})
        assert st["extras"] == []
        assert c.get(f"/v1/jobs/{job_id}/files/glossary").status_code == 404
