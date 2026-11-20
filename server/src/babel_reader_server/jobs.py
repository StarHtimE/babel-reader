"""任务状态与队列。任务串行执行：同一时间只有一个翻译在跑。"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import shutil
import tempfile
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from .config import Profile

log = logging.getLogger(__name__)

OutputKind = Literal["mono", "dual"]

_LANG_PATTERN = r"^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$"
_PAGES_PATTERN = r"^\s*\d*\s*-?\s*\d*\s*(,\s*\d*\s*-?\s*\d*\s*)*$"


_NUMBER_PATTERN = r"^\d+(\.\d+)?$"


class LlmOptions(BaseModel):
    """插件设置里的大模型配置，随任务一起提交；提供时优先于 config.toml 的 profile。

    api_key 用 SecretStr：打印、日志和校验错误里都不会出现明文。
    """

    model_config = ConfigDict(extra="ignore")

    name: Annotated[str, Field(min_length=1, max_length=100)] = "plugin"
    base_url: Annotated[str, Field(pattern=r"^https?://\S+$", max_length=2000)]
    api_key: Annotated[SecretStr, Field(min_length=1, max_length=4000)]
    model: Annotated[str, Field(min_length=1, max_length=200)]
    qps: Annotated[int, Field(ge=1, le=100)] = 4
    temperature: Annotated[str | None, Field(pattern=_NUMBER_PATTERN)] = None
    timeout: Annotated[str | None, Field(pattern=_NUMBER_PATTERN)] = None
    extra_body: dict[str, Any] | None = None

    def to_profile(self) -> Profile:
        return Profile(
            name=self.name,
            base_url=self.base_url,
            api_key=self.api_key.get_secret_value(),
            model=self.model,
            qps=self.qps,
            temperature=self.temperature,
            timeout=self.timeout,
            extra_body=self.extra_body or None,
        )


class JobOptions(BaseModel):
    """POST /v1/jobs 的 options 字段。未知字段忽略，便于插件先于服务端升级。"""

    model_config = ConfigDict(extra="ignore")

    lang_in: Annotated[str, Field(pattern=_LANG_PATTERN)] = "en"
    lang_out: Annotated[str, Field(pattern=_LANG_PATTERN)] = "zh"
    profile: str | None = None
    llm: LlmOptions | None = None
    pages: Annotated[str | None, Field(max_length=500)] = None
    outputs: list[OutputKind] = Field(default_factory=lambda: ["mono", "dual"])
    dual_translate_first: bool = False
    ignore_cache: bool = False
    glossary_csv: Annotated[str | None, Field(max_length=1_000_000)] = None

    @field_validator("pages")
    @classmethod
    def _check_pages(cls, v: str | None) -> str | None:
        import re

        if v is None or v.strip() == "":
            return None
        if not re.fullmatch(_PAGES_PATTERN, v) or not any(ch.isdigit() for ch in v):
            raise ValueError("pages 格式应形如 '1-3,5'")
        return v.replace(" ", "")

    @field_validator("outputs")
    @classmethod
    def _check_outputs(cls, v: list[OutputKind]) -> list[OutputKind]:
        unique = list(dict.fromkeys(v))
        if not unique:
            raise ValueError("outputs 不能为空")
        return unique


class JobState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"
    CANCELLED = "cancelled"


TERMINAL_STATES = frozenset({JobState.DONE, JobState.ERROR, JobState.CANCELLED})


@dataclass
class Job:
    id: str
    options: JobOptions
    work_dir: Path
    input_path: Path
    #: 已解析好的大模型配置（来自 config.toml 或插件）；可能含 API key，不要打印
    profile: Profile = field(repr=False)
    state: JobState = JobState.QUEUED
    stage: str | None = None
    stage_progress: float = 0.0
    overall_progress: float = 0.0
    error: str | None = None
    outputs: dict[OutputKind, Path] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    task: asyncio.Task[dict[OutputKind, Path]] | None = None

    @property
    def output_dir(self) -> Path:
        return self.work_dir / "out"

    @property
    def glossary_path(self) -> Path | None:
        p = self.work_dir / "glossary.csv"
        return p if p.is_file() else None

    def to_status(self) -> dict[str, Any]:
        status: dict[str, Any] = {
            "state": self.state.value,
            "stage": self.stage,
            "stage_progress": round(self.stage_progress, 2),
            "overall_progress": round(self.overall_progress, 2),
        }
        if self.error is not None:
            status["error"] = self.error
        if self.state is JobState.DONE:
            status["outputs"] = [k for k in ("mono", "dual") if k in self.outputs]
        return status

    def update_progress(
        self, stage: str | None, stage_progress: float, overall: float | None
    ) -> None:
        if self.state is not JobState.RUNNING:
            return
        if stage:
            self.stage = stage
        self.stage_progress = min(100.0, max(0.0, stage_progress))
        if overall is not None:
            # 总进度只增不减
            self.overall_progress = max(self.overall_progress, min(100.0, max(0.0, overall)))


#: 执行一个任务，返回 {种类: 结果文件}；通过回调报告进度
Runner = Callable[
    [Job, Callable[[str | None, float, float | None], None]], Awaitable[dict[OutputKind, Path]]
]


def _remove_tree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


class JobManager:
    def __init__(
        self,
        runner: Runner,
        *,
        work_root: Path | None = None,
        result_ttl_seconds: float = 3600,
        cleanup_interval_seconds: float = 60,
    ) -> None:
        self._runner = runner
        self._ttl = result_ttl_seconds
        self._cleanup_interval = cleanup_interval_seconds
        if work_root is not None:
            work_root.mkdir(parents=True, exist_ok=True)
        self._tmp = tempfile.TemporaryDirectory(
            prefix="babel-reader-", dir=work_root, ignore_cleanup_errors=True
        )
        self.root = Path(self._tmp.name)
        self._jobs: dict[str, Job] = {}
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._worker_task: asyncio.Task[None] | None = None
        self._cleanup_task: asyncio.Task[None] | None = None

    # ---- 生命周期 -------------------------------------------------------

    async def start(self) -> None:
        self._worker_task = asyncio.create_task(self._worker(), name="babel-reader-worker")
        self._cleanup_task = asyncio.create_task(self._cleanup_loop(), name="babel-reader-cleanup")

    async def stop(self) -> None:
        for job in self._jobs.values():
            if job.task is not None and not job.task.done():
                job.task.cancel()
        for t in (self._worker_task, self._cleanup_task):
            if t is not None:
                t.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await t
        for job in self._jobs.values():
            if job.task is not None:
                with contextlib.suppress(BaseException):
                    await job.task
        self._tmp.cleanup()

    # ---- 对外操作 -------------------------------------------------------

    def submit(self, pdf: bytes, options: JobOptions, profile: Profile) -> Job:
        job_id = secrets.token_urlsafe(12)
        work_dir = self.root / job_id
        work_dir.mkdir()
        input_path = work_dir / "input.pdf"
        input_path.write_bytes(pdf)
        if options.glossary_csv:
            (work_dir / "glossary.csv").write_text(options.glossary_csv, encoding="utf-8")
        job = Job(
            id=job_id,
            options=options,
            work_dir=work_dir,
            input_path=input_path,
            profile=profile,
        )
        job.output_dir.mkdir()
        self._jobs[job_id] = job
        self._queue.put_nowait(job_id)
        log.info("任务 %s 已排队（profile=%s，model=%s）", job_id, profile.name, profile.model)
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> Job | None:
        """取消排队或运行中的任务；已结束的任务则丢弃其结果文件。"""
        job = self._jobs.get(job_id)
        if job is None:
            return None
        if job.state in TERMINAL_STATES:
            self._discard_files(job)
            return job
        was_running = job.state is JobState.RUNNING
        job.state = JobState.CANCELLED
        job.finished_at = time.time()
        if was_running and job.task is not None and not job.task.done():
            # 文件等任务真正结束后由 worker 删除
            job.task.cancel()
        else:
            self._discard_files(job)
        log.info("任务 %s 已取消", job_id)
        return job

    def purge_expired(self, now: float | None = None) -> int:
        now = time.time() if now is None else now
        expired = [
            j.id
            for j in self._jobs.values()
            if j.state in TERMINAL_STATES
            and j.finished_at is not None
            and now - j.finished_at > self._ttl
            and (j.task is None or j.task.done())
        ]
        for job_id in expired:
            job = self._jobs.pop(job_id)
            _remove_tree(job.work_dir)
        return len(expired)

    # ---- 内部 -----------------------------------------------------------

    def _discard_files(self, job: Job) -> None:
        job.outputs = {}
        _remove_tree(job.work_dir)

    async def _worker(self) -> None:
        while True:
            job_id = await self._queue.get()
            try:
                job = self._jobs.get(job_id)
                if job is None or job.state is not JobState.QUEUED:
                    continue
                await self._run(job)
            finally:
                self._queue.task_done()

    async def _run(self, job: Job) -> None:
        job.state = JobState.RUNNING
        job.stage = None
        log.info("任务 %s 开始", job.id)
        task = asyncio.create_task(self._runner(job, job.update_progress), name=f"job-{job.id}")
        job.task = task
        # 用 wait 而不是直接 await：区分「任务被取消」和「worker 自己被取消」
        await asyncio.wait({task})

        if job.state is JobState.CANCELLED or task.cancelled():
            job.state = JobState.CANCELLED
            job.finished_at = job.finished_at or time.time()
            self._discard_files(job)
            log.info("任务 %s 已中止", job.id)
            return

        exc = task.exception()
        job.finished_at = time.time()
        if exc is not None:
            job.state = JobState.ERROR
            job.error = str(exc) or exc.__class__.__name__
            log.error("任务 %s 失败：%s", job.id, job.error, exc_info=exc)
            return

        job.outputs = task.result()
        job.state = JobState.DONE
        job.stage_progress = 100.0
        job.overall_progress = 100.0
        log.info("任务 %s 完成：%s", job.id, ", ".join(job.outputs))

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(self._cleanup_interval)
            try:
                n = self.purge_expired()
                if n:
                    log.info("清理了 %d 个过期任务", n)
            except Exception:
                log.exception("清理过期任务失败")
