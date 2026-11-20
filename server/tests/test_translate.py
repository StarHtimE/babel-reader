"""translate.py：SettingsModel 映射 + 用假事件流替换 do_translate_async_stream。"""

import asyncio
import pickle
from pathlib import Path
from types import SimpleNamespace

import pytest

from babel_reader_server import translate
from babel_reader_server.config import Profile
from babel_reader_server.jobs import JobOptions

PROFILE = Profile(name="p", base_url="https://api.example.com", api_key="sk-test", model="m", qps=3)


def test_build_settings_keeps_page_identity(tmp_path: Path):
    opts = JobOptions(lang_in="en", lang_out="zh", pages="1-3,5", dual_translate_first=True)
    s = translate.build_settings(opts, PROFILE, tmp_path, None)
    assert s.translation.lang_in == "en"
    assert s.translation.lang_out == "zh"
    assert s.translation.output == str(tmp_path)
    assert s.translation.qps == 3
    assert s.translation.glossaries is None
    assert s.pdf.pages == "1-3,5"
    # 核心约束：左右并排、保留未翻译页、无水印
    assert s.pdf.use_alternating_pages_dual is False
    assert s.pdf.only_include_translated_page is False
    assert s.pdf.watermark_output_mode == "no_watermark"
    assert s.pdf.dual_translate_first is True
    assert s.pdf.no_mono is False
    assert s.pdf.no_dual is False
    engine = s.translate_engine_settings
    assert engine.translate_engine_type == "OpenAI"
    assert engine.openai_model == "m"
    assert engine.openai_api_key == "sk-test"
    assert engine.openai_base_url == "https://api.example.com"
    # 没配 temperature / extra_body 时都不发送
    assert not engine.openai_send_temprature
    assert engine._openai_extra_body is None


THINKING_OFF = {"thinking": {"type": "disabled"}}


def _validated_and_pickled(profile: Profile, tmp_path: Path):
    """模拟 pdf2zh_next 的真实路径：先 validate_settings，再 pickle 传给翻译子进程。"""
    s = translate.build_settings(JobOptions(), profile, tmp_path, None)
    s.validate_settings()
    return pickle.loads(pickle.dumps(s))


def test_extra_body_reaches_translator_request_options(tmp_path: Path):
    from pdf2zh_next.translator.translator_impl.openai import OpenAITranslator

    profile = Profile(
        name="ds",
        base_url="https://api.example.com",
        api_key="sk-test",
        model="deepseek-flash",
        temperature="0.3",
        extra_body=THINKING_OFF,
    )
    s = _validated_and_pickled(profile, tmp_path)
    # 校验后引擎没有被转换成别的类型，extra_body 也没丢
    assert s.translate_engine_settings.translate_engine_type == "OpenAI"
    assert s.translate_engine_settings._openai_extra_body == THINKING_OFF

    # 直接构造上游 OpenAITranslator：只建客户端不发请求（get_translator 会先探测接口）
    translator = OpenAITranslator(s, rate_limiter=None)
    assert translator.options["extra_body"] == THINKING_OFF
    assert translator.options["temperature"] == 0.3


def test_extra_body_is_copied_not_shared(tmp_path: Path):
    body = {"thinking": {"type": "disabled"}}
    profile = Profile(name="ds", base_url="u", api_key="k", model="m", extra_body=body)
    engine = translate.build_engine_settings(profile)
    engine._openai_extra_body["thinking"]["type"] = "enabled"
    assert body["thinking"]["type"] == "disabled"


def test_no_extra_body_sends_nothing_extra(tmp_path: Path):
    from pdf2zh_next.translator.translator_impl.openai import OpenAITranslator

    s = _validated_and_pickled(PROFILE, tmp_path)
    translator = OpenAITranslator(s, rate_limiter=None)
    assert "extra_body" not in translator.options
    assert "temperature" not in translator.options


def test_build_settings_mono_only_and_glossary(tmp_path: Path):
    g = tmp_path / "g.csv"
    g.write_text("source,target\nspeckle,相干斑\n", encoding="utf-8")
    opts = JobOptions(outputs=["mono"], ignore_cache=True)
    s = translate.build_settings(opts, PROFILE, tmp_path, g)
    assert s.pdf.no_dual is True
    assert s.pdf.no_mono is False
    assert s.translation.ignore_cache is True
    assert s.translation.glossaries == str(g)


def _install_fake_stream(monkeypatch, events, *, record=None):
    async def fake(settings, file):
        if record is not None:
            record["settings"] = settings
            record["file"] = file
        try:
            for e in events:
                if e == "hang":
                    await asyncio.sleep(3600)
                yield e
        finally:
            if record is not None:
                record["closed"] = True

    monkeypatch.setattr(translate, "do_translate_async_stream", fake)


def _pdf(path: Path) -> Path:
    path.write_bytes(b"%PDF-1.7\n")
    return path


def test_run_translation_reports_progress_and_returns_outputs(tmp_path, monkeypatch):
    mono = _pdf(tmp_path / "x.zh.mono.pdf")
    dual = _pdf(tmp_path / "x.zh.dual.pdf")
    result = SimpleNamespace(mono_pdf_path=mono, dual_pdf_path=dual)
    record: dict = {}
    _install_fake_stream(
        monkeypatch,
        [
            {"type": "progress_start", "stage": "Parse", "stage_progress": 0.0},
            {
                "type": "progress_update",
                "stage": "Parse",
                "stage_progress": 50.0,
                "overall_progress": 10.0,
            },
            {"type": "progress_end", "stage": "Parse", "stage_progress": 100.0},
            {"type": "finish", "translate_result": result},
        ],
        record=record,
    )
    seen = []
    out = asyncio.run(
        translate.run_translation(
            tmp_path / "in.pdf", tmp_path, JobOptions(), PROFILE, lambda *a: seen.append(a)
        )
    )
    assert out == {"mono": mono, "dual": dual}
    assert seen == [("Parse", 0.0, None), ("Parse", 50.0, 10.0), ("Parse", 100.0, None)]
    assert record["closed"] is True
    assert record["settings"].pdf.watermark_output_mode == "no_watermark"


def test_run_translation_falls_back_to_no_watermark_path(tmp_path, monkeypatch):
    mono = _pdf(tmp_path / "m.pdf")
    result = SimpleNamespace(mono_pdf_path=None, no_watermark_mono_pdf_path=str(mono))
    _install_fake_stream(monkeypatch, [{"type": "finish", "translate_result": result}])
    out = asyncio.run(
        translate.run_translation(
            tmp_path / "in.pdf", tmp_path, JobOptions(outputs=["mono"]), PROFILE, lambda *a: None
        )
    )
    assert out == {"mono": mono}


def test_run_translation_error_event(tmp_path, monkeypatch):
    _install_fake_stream(monkeypatch, [{"type": "error", "error": "API key 无效"}])
    with pytest.raises(translate.TranslationFailed, match="API key 无效"):
        asyncio.run(
            translate.run_translation(
                tmp_path / "in.pdf", tmp_path, JobOptions(), PROFILE, lambda *a: None
            )
        )


def test_run_translation_missing_output(tmp_path, monkeypatch):
    result = SimpleNamespace(mono_pdf_path=tmp_path / "nope.pdf", dual_pdf_path=None)
    _install_fake_stream(monkeypatch, [{"type": "finish", "translate_result": result}])
    with pytest.raises(translate.TranslationFailed, match="mono"):
        asyncio.run(
            translate.run_translation(
                tmp_path / "in.pdf", tmp_path, JobOptions(), PROFILE, lambda *a: None
            )
        )


def test_run_translation_stream_ends_without_finish(tmp_path, monkeypatch):
    _install_fake_stream(monkeypatch, [])
    with pytest.raises(translate.TranslationFailed, match="完成事件"):
        asyncio.run(
            translate.run_translation(
                tmp_path / "in.pdf", tmp_path, JobOptions(), PROFILE, lambda *a: None
            )
        )


def test_cancel_closes_stream(tmp_path, monkeypatch):
    record: dict = {}
    _install_fake_stream(
        monkeypatch, [{"type": "progress_start", "stage": "Parse"}, "hang"], record=record
    )

    async def main():
        task = asyncio.create_task(
            translate.run_translation(
                tmp_path / "in.pdf", tmp_path, JobOptions(), PROFILE, lambda *a: None
            )
        )
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())
    assert record["closed"] is True


def test_engine_versions():
    pdf2zh, babeldoc = translate.engine_versions()
    assert pdf2zh != "unknown"
    assert babeldoc != "unknown"
