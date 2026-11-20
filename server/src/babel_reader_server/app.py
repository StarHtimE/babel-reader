"""FastAPI 路由（HTTP 接口 v1）。"""

from __future__ import annotations

import hmac
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import ValidationError

from . import __version__
from .config import ServerConfig
from .jobs import Job, JobManager, JobOptions, JobState, OutputKind

log = logging.getLogger(__name__)

_CHUNK = 1024 * 1024

#: (input_path, output_dir, options, profile, on_progress, glossary_path) → 结果
Translator = Callable[..., Awaitable[dict[OutputKind, Path]]]
VersionsProvider = Callable[[], tuple[str, str]]


def _default_translator() -> tuple[Translator, VersionsProvider]:
    # 延迟导入：只有真正启动服务时才加载 pdf2zh_next
    from . import translate

    return translate.run_translation, translate.engine_versions


def create_app(
    config: ServerConfig,
    *,
    translator: Translator | None = None,
    versions: VersionsProvider | None = None,
    cleanup_interval_seconds: float = 60,
) -> FastAPI:
    if translator is None or versions is None:
        default_translator, default_versions = _default_translator()
        translator = translator or default_translator
        versions = versions or default_versions
    run_translation = translator
    get_versions = versions

    async def runner(
        job: Job, on_progress: Callable[[str | None, float, float | None], None]
    ) -> dict[OutputKind, Path]:
        return await run_translation(
            job.input_path,
            job.output_dir,
            job.options,
            job.profile,
            on_progress,
            job.glossary_path,
        )

    manager = JobManager(
        runner,
        work_root=config.work_dir,
        result_ttl_seconds=config.result_ttl_seconds,
        cleanup_interval_seconds=cleanup_interval_seconds,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await manager.start()
        try:
            yield
        finally:
            await manager.stop()

    app = FastAPI(title="Babel Reader Server", version=__version__, lifespan=lifespan)
    app.state.manager = manager

    async def require_token(request: Request) -> None:
        if not config.token:
            return
        header = request.headers.get("authorization", "")
        scheme, _, value = header.partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(
            value.strip().encode(), config.token.encode()
        ):
            raise HTTPException(status_code=401, detail="访问令牌不正确或缺失")

    router = APIRouter(prefix="/v1", dependencies=[Depends(require_token)])

    def get_job_or_404(job_id: str) -> Job:
        job = manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="任务不存在或已过期")
        return job

    @router.get("/health")
    async def health() -> dict[str, Any]:
        pdf2zh_version, babeldoc_version = get_versions()
        return {
            "ok": True,
            "server_version": __version__,
            "pdf2zh_next_version": pdf2zh_version,
            "babeldoc_version": babeldoc_version,
            # 可选功能；插件据此判断能否提交 options.llm（旧版服务端会忽略它）
            "features": ["llm"],
        }

    @router.get("/profiles")
    async def profiles() -> dict[str, Any]:
        return {"profiles": config.profile_names()}

    @router.post("/jobs")
    async def create_job(
        file: Annotated[UploadFile, File()],
        options: Annotated[str, Form()],
    ) -> dict[str, str]:
        try:
            opts = JobOptions.model_validate(json.loads(options))
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail="options 不是合法的 JSON") from e
        except ValidationError as e:
            first = e.errors()[0]
            loc = ".".join(str(x) for x in first.get("loc", ()))
            raise HTTPException(
                status_code=400, detail=f"options.{loc} 不合法：{first.get('msg')}"
            ) from e

        if opts.llm is not None:
            # 插件提供了大模型配置：优先使用。之后只在 Job.profile 里保留密钥，options 里去掉
            profile = opts.llm.to_profile()
            opts = opts.model_copy(update={"llm": None})
        else:
            found = config.find_profile(opts.profile)
            if found is None:
                if not config.profiles:
                    raise HTTPException(
                        status_code=400,
                        detail="服务端没有配置任何 profile，请在插件设置里添加大模型配置",
                    )
                raise HTTPException(status_code=400, detail=f"未知的 profile：{opts.profile}")
            profile = found

        limit = config.max_upload_mb * 1024 * 1024
        data = bytearray()
        while chunk := await file.read(_CHUNK):
            data.extend(chunk)
            if len(data) > limit:
                raise HTTPException(
                    status_code=413, detail=f"PDF 超过 {config.max_upload_mb} MB 上限"
                )
        await file.close()
        if not data.startswith(b"%PDF-"):
            raise HTTPException(status_code=400, detail="上传的文件不是 PDF")

        job = manager.submit(bytes(data), opts, profile)
        return {"job_id": job.id}

    @router.get("/jobs/{job_id}")
    async def get_job(job_id: str) -> dict[str, Any]:
        return get_job_or_404(job_id).to_status()

    @router.delete("/jobs/{job_id}")
    async def cancel_job(job_id: str) -> dict[str, Any]:
        get_job_or_404(job_id)
        job = manager.cancel(job_id)
        assert job is not None
        return job.to_status()

    @router.get("/jobs/{job_id}/files/{kind}")
    async def get_file(job_id: str, kind: str) -> FileResponse:
        if kind not in ("mono", "dual"):
            raise HTTPException(status_code=404, detail="kind 只能是 mono 或 dual")
        job = get_job_or_404(job_id)
        if job.state is not JobState.DONE:
            raise HTTPException(status_code=409, detail=f"任务尚未完成（{job.state.value}）")
        path = job.outputs.get(kind)  # type: ignore[call-overload]
        if path is None or not path.is_file():
            raise HTTPException(status_code=404, detail=f"没有 {kind} 结果")
        return FileResponse(path, media_type="application/pdf", filename=f"{kind}.pdf")

    app.include_router(router)
    return app
