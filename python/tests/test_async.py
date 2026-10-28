from __future__ import annotations

import asyncio
import threading
import time

import pytest
from test_device import (
    APP_ID,
    PROXY,
    STOP,
    FakeRevyl,
    Reply,
    Request,
    fake,
    isolated_environment,
    png,
)

import revyl_verify as verify
from revyl_verify import Target

__all__ = ["fake", "isolated_environment"]


async def event_is_set(event: threading.Event, timeout: float = 3) -> None:
    deadline = time.monotonic() + timeout
    while not event.is_set():
        assert time.monotonic() < deadline, "background operation did not reach its checkpoint"
        await asyncio.sleep(0.005)


async def stopped(fake: FakeRevyl) -> None:
    deadline = time.monotonic() + 3
    while not fake.calls("POST", STOP):
        assert time.monotonic() < deadline, "cancelled session was not released"
        await asyncio.sleep(0.005)


def test_async_context_methods_do_not_block_event_loop(fake: FakeRevyl) -> None:
    entered, release = threading.Event(), threading.Event()

    def handler(request: Request) -> Reply | None:
        if request.path == PROXY + "execute_step":
            entered.set()
            assert release.wait(3)
        return None

    fake.handler = handler

    async def run() -> None:
        session = await verify.async_open(
            Target(platform="ios", app_id=APP_ID),
            backend_url=fake.url,
            app_url="https://viewer.test",
        )
        async with session:
            operation = asyncio.create_task(session.instruction("Open settings"))
            try:
                await event_is_set(entered)
                assert not operation.done()
                ticks = 0
                for _ in range(5):
                    await asyncio.sleep(0.005)
                    ticks += 1
                assert ticks == 5 and not operation.done()
            finally:
                release.set()
            result = await operation
            assert result.passed
            assert (await session.validation("Settings visible")).passed
            assert await session.screenshot() == png()
            assert (await session.report())["status"] == "running"
            snapshot = session.steps
            snapshot.clear()
            assert len(session.steps) == 2
            assert session.platform == "ios" and not session.closed
            assert session.id and session.viewer_url.startswith("https://viewer.test/sessions/")
        assert session.closed
        await session.close()

    asyncio.run(run())
    assert len(fake.calls("POST", STOP)) == 1


def test_async_open_is_nonblocking_and_cancelled_start_is_released(fake: FakeRevyl) -> None:
    entered, release = threading.Event(), threading.Event()

    def handler(request: Request) -> Reply | None:
        if "/worker-connection/" in request.path:
            entered.set()
            assert release.wait(3)
        return None

    fake.handler = handler

    async def run() -> None:
        opening = asyncio.create_task(
            verify.async_open(
                Target(platform="android", app_id=APP_ID),
                backend_url=fake.url,
            )
        )
        try:
            await event_is_set(entered)
            assert not opening.done()
            opening.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(opening, timeout=0.5)
        finally:
            release.set()
        await stopped(fake)

    asyncio.run(run())
    assert len(fake.calls("POST", STOP)) == 1


def test_async_cancelled_method_closes_session_without_replay(fake: FakeRevyl) -> None:
    entered, release = threading.Event(), threading.Event()

    def handler(request: Request) -> Reply | None:
        if request.path == PROXY + "execute_step":
            entered.set()
            assert release.wait(3)
        return None

    fake.handler = handler

    async def run() -> None:
        session = await verify.async_open(
            Target(platform="ios", app_id=APP_ID),
            backend_url=fake.url,
        )
        task = asyncio.create_task(session.instruction("Open settings"))
        try:
            await event_is_set(entered)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, timeout=0.5)
            await stopped(fake)
            assert session.closed
        finally:
            release.set()
            await session.close()

    asyncio.run(run())
    assert len(fake.calls("POST", PROXY + "execute_step")) == 1
    assert len(fake.calls("POST", STOP)) == 1


def test_async_context_releases_after_exception(fake: FakeRevyl) -> None:
    async def run() -> None:
        session = await verify.async_open(
            Target(platform="android", app_id=APP_ID),
            backend_url=fake.url,
        )
        with pytest.raises(RuntimeError, match="body failed"):
            async with session:
                raise RuntimeError("body failed")
        assert session.closed

    asyncio.run(run())
    assert len(fake.calls("POST", STOP)) == 1


def test_cancelled_open_releases_after_event_loop_shutdown(fake: FakeRevyl) -> None:
    entered, release = threading.Event(), threading.Event()
    timers: list[threading.Timer] = []

    def handler(request: Request) -> Reply | None:
        if "/worker-connection/" in request.path:
            entered.set()
            assert release.wait(10)
        return None

    fake.handler = handler

    async def run() -> None:
        opening = asyncio.create_task(
            verify.async_open(
                Target(platform="ios", app_id=APP_ID),
                backend_url=fake.url,
            )
        )
        await event_is_set(entered)
        opening.cancel()
        with pytest.raises(asyncio.CancelledError):
            await opening
        timer = threading.Timer(5, release.set)
        timers.append(timer)
        timer.start()

    try:
        asyncio.run(run())
        deadline = time.monotonic() + 3
        while not fake.calls("POST", STOP):
            assert time.monotonic() < deadline
            time.sleep(0.005)
        assert not release.is_set()
    finally:
        release.set()
        for timer in timers:
            timer.cancel()
            timer.join(3)
    assert len(fake.calls("POST", STOP)) == 1
