"""唯一直接依赖 pdf2zh_next / BabelDOC 的模块。

字段名依据 pdf2zh_next 2.10.2 / BabelDOC 0.7.1 源码：
- pdf2zh_next.config.model: SettingsModel / TranslationSettings / PDFSettings
- pdf2zh_next.high_level.do_translate_async_stream：产出 progress_start / progress_update /
  progress_end / finish / error 事件；finish 事件的 translate_result 带 mono_pdf_path、
  dual_pdf_path（babeldoc.format.pdf.translation_config.TranslateResult）
- 取消：取消正在 await 该异步生成器的 asyncio task，生成器的 finally 会结束翻译子进程
- warmup：babeldoc.assets.assets.warmup()（pdf2zh_next CLI 启动时也调用它）
- 大模型接口：OpenAISettings（见 build_engine_settings）
"""

from __future__ import annotations

import contextlib
import copy
import logging
from collections.abc import Callable
from importlib import metadata
from pathlib import Path
from typing import Any

from pdf2zh_next import SettingsModel, do_translate_async_stream
from pdf2zh_next.config.model import PDFSettings, TranslationSettings
from pdf2zh_next.config.translate_engine_model import OpenAISettings

from .config import Profile
from .jobs import FileKind, JobOptions, OutputKind

log = logging.getLogger(__name__)

#: (stage, stage_progress, overall_progress)
ProgressCallback = Callable[[str | None, float, float | None], None]


class TranslationFailed(Exception):
    """pdf2zh_next 报告翻译失败。"""


def engine_versions() -> tuple[str, str]:
    """返回 (pdf2zh_next 版本, babeldoc 版本)。"""

    def ver(dist: str) -> str:
        try:
            return metadata.version(dist)
        except metadata.PackageNotFoundError:
            return "unknown"

    return ver("pdf2zh-next"), ver("babeldoc")


def build_settings(
    options: JobOptions,
    profile: Profile,
    output_dir: Path,
    glossary_path: Path | None = None,
) -> SettingsModel:
    """把插件传来的 options 映射到 pdf2zh_next 的 SettingsModel。"""
    return SettingsModel(
        report_interval=0.5,
        translation=TranslationSettings(
            lang_in=options.lang_in,
            lang_out=options.lang_out,
            output=str(output_dir),
            qps=profile.qps,
            ignore_cache=options.ignore_cache,
            glossaries=str(glossary_path) if glossary_path else None,
            no_auto_extract_glossary=not options.auto_extract_glossary,
        ),
        pdf=PDFSettings(
            pages=options.pages,
            no_mono="mono" not in options.outputs,
            no_dual="dual" not in options.outputs,
            dual_translate_first=options.dual_translate_first,
            # 页码恒等：对照版只用左右并排，部分翻译时保留未翻译的页
            use_alternating_pages_dual=False,
            only_include_translated_page=False,
            watermark_output_mode="no_watermark",
        ),
        translate_engine_settings=build_engine_settings(profile),
    )


def build_engine_settings(profile: Profile) -> OpenAISettings:
    """直接构造 OpenAISettings，而不是 OpenAICompatibleSettings。

    OpenAICompatibleSettings.transform() 既不传 extra_body，也不打开 temperature 的发送开关；
    OpenAISettings 有私有字段 _openai_extra_body，OpenAITranslator 会把它作为 extra_body
    放进每次请求，并计入翻译缓存的键（pdf2zh_next 自带的 DeepSeek 引擎就是这样关闭思考的）。
    """
    engine = OpenAISettings(
        openai_model=profile.model,
        openai_base_url=profile.base_url,
        openai_api_key=profile.api_key,
        openai_timeout=profile.timeout,
        openai_temperature=profile.temperature,
        openai_send_temprature=profile.temperature is not None,  # 上游字段名就是这么拼的
    )
    if profile.extra_body:
        engine._openai_extra_body = copy.deepcopy(profile.extra_body)
    return engine


def _result_path(result: Any, kind: OutputKind) -> Path | None:
    for attr in (f"{kind}_pdf_path", f"no_watermark_{kind}_pdf_path"):
        value = getattr(result, attr, None)
        if value:
            return Path(value)
    return None


def _as_float(value: Any) -> float | None:
    if isinstance(value, int | float) and not isinstance(value, bool):
        return float(value)
    return None


async def run_translation(
    input_path: Path,
    output_dir: Path,
    options: JobOptions,
    profile: Profile,
    on_progress: ProgressCallback,
    glossary_path: Path | None = None,
) -> dict[FileKind, Path]:
    """执行一次翻译，返回 {种类: 结果文件路径}。被取消时抛出 CancelledError。

    除了 PDF，上游自动抽取的术语（BabelDOC 默认保存为 CSV）有就一并返回，种类为 glossary。
    """
    settings = build_settings(options, profile, output_dir, glossary_path)
    stream = do_translate_async_stream(settings, input_path)
    async with contextlib.aclosing(stream):
        async for event in stream:
            etype = event.get("type")
            if etype in ("progress_start", "progress_update", "progress_end"):
                stage = event.get("stage")
                on_progress(
                    stage if isinstance(stage, str) else None,
                    _as_float(event.get("stage_progress")) or 0.0,
                    _as_float(event.get("overall_progress")),
                )
            elif etype == "error":
                raise TranslationFailed(str(event.get("error") or "未知错误"))
            elif etype == "finish":
                result = event.get("translate_result")
                outputs: dict[FileKind, Path] = {}
                for kind in options.outputs:
                    path = _result_path(result, kind)
                    if path is None or not path.is_file():
                        raise TranslationFailed(f"翻译完成但找不到 {kind} 结果文件")
                    outputs[kind] = path
                glossary = getattr(result, "auto_extracted_glossary_path", None)
                if options.auto_extract_glossary and glossary and Path(glossary).is_file():
                    outputs["glossary"] = Path(glossary)
                return outputs
    raise TranslationFailed("翻译流程意外结束，没有收到完成事件")


def warmup() -> None:
    """下载并校验 BabelDOC 需要的版面模型和字体。"""
    from babeldoc.assets import assets

    assets.warmup()
