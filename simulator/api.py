"""HTTP and WebSocket. Provided, except the TASK block in ``serve_ws``."""

from __future__ import annotations

import asyncio
import os
import random
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from simulator.engine import Run, new_run
from simulator.events import Event
from simulator.retry import handle_retry
from simulator.stream import Stream
from simulator.workflow import DEFAULT_WORKFLOW, DEVICES


@dataclass
class Config:
    """Set from the environment. Every chaos knob is off by default.

    REPLAY_BUFFER_SIZE  how many events the stream can replay  (default 64)
    FAIL_STEP           step that fails once, on its first attempt
    REORDER_PCT         events delivered out of order
    DUPLICATE_PCT       events delivered twice
    SOCKET_KILL_MS      server drops each socket after this long
    SOCKET_REJECT_MS    after a drop, the server refuses to reconnect for this
                        long -- long enough for the buffer to move past you
    """

    replay_buffer_size: int = 64
    fail_step: str = ""
    reorder_pct: int = 0
    duplicate_pct: int = 0
    socket_kill_ms: int = 0
    socket_reject_ms: int = 0

    @classmethod
    def from_env(cls) -> Config:
        def num(key: str, default: int) -> int:
            try:
                return int(os.environ.get(key, "") or default)
            except ValueError:
                return default

        return cls(
            replay_buffer_size=num("REPLAY_BUFFER_SIZE", 64),
            fail_step=os.environ.get("FAIL_STEP", ""),
            reorder_pct=num("REORDER_PCT", 0),
            duplicate_pct=num("DUPLICATE_PCT", 0),
            socket_kill_ms=num("SOCKET_KILL_MS", 0),
            socket_reject_ms=num("SOCKET_REJECT_MS", 0),
        )


class Server:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.runs: dict[str, Run] = {}
        # One stream per run: a viewer of r-1 must not see r-2.
        self.streams: dict[str, Stream] = {}
        self._order: list[str] = []
        self._open_from = 0.0
        self._held: list[Event] = []


def create_app(cfg: Config | None = None) -> FastAPI:
    server = Server(cfg or Config.from_env())
    app = FastAPI()
    app.state.server = server
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> dict[str, Any]:
        c = server.cfg
        return {
            "status": "ok",
            # What the knobs are set to. The scripts read this so they can warn
            # you when a check is about to fail for a reason you switched on.
            "config": {
                "fail_step": c.fail_step,
                "reorder_pct": c.reorder_pct,
                "duplicate_pct": c.duplicate_pct,
                "socket_kill_ms": c.socket_kill_ms,
                "socket_reject_ms": c.socket_reject_ms,
                "replay_buffer_size": c.replay_buffer_size,
            },
        }

    @app.get("/workflows")
    async def workflows() -> dict[str, Any]:
        return {
            "steps": [
                {
                    "id": d.id,
                    "device_id": d.device_id,
                    "depends_on": list(d.depends_on),
                }
                for d in DEFAULT_WORKFLOW
            ],
            "devices": list(DEVICES),
        }

    @app.get("/runs")
    async def list_runs() -> dict[str, Any]:
        return {"runs": [{"id": i, "status": server.runs[i].status} for i in server._order]}

    @app.post("/runs", status_code=201)
    async def create_run() -> dict[str, str]:
        run_id = f"r-{len(server._order) + 1}"
        stream = Stream(server.cfg.replay_buffer_size)
        server.streams[run_id] = stream
        server.runs[run_id] = new_run(run_id, stream, server.cfg.fail_step)
        server._order.append(run_id)
        return {"id": run_id}

    @app.get("/runs/{run_id}")
    async def snapshot(run_id: str) -> Response:
        """The projection a client loads before it subscribes.

        The seq field is the stream watermark: the position in the event stream
        that this snapshot reflects. A client reads it and subscribes with
        ?resume_from=<seq>, so the replay covers exactly the window between the
        two and nothing is lost or applied twice.

        Provided, and it will keep reporting 0 until Stream.watermark does
        something.
        """
        run = server.runs.get(run_id)
        if run is None:
            return JSONResponse({"error": "no such run"}, status_code=404)
        seq = await server.streams[run_id].watermark()
        async with run.lock:
            steps = [s.as_dict() for s in run.ordered_steps()]
            status = run.status
        return JSONResponse({"seq": seq, "run": {"id": run_id, "status": status, "steps": steps}})

    @app.post("/runs/{run_id}/start", status_code=202)
    async def start_run(run_id: str) -> Response:
        run = server.runs.get(run_id)
        if run is None:
            return JSONResponse({"error": "no such run"}, status_code=404)
        await run.start()
        return JSONResponse({"id": run_id, "status": "running"}, status_code=202)

    @app.post("/runs/{run_id}/steps/{step_id}/retry")
    async def retry(run_id: str, step_id: str, request: Request) -> Response:
        # The body is passed raw: it is optional, and a malformed one is the
        # handler's to report (400 INVALID_BODY), not FastAPI's.
        body = await request.body()
        return await handle_retry(server.runs.get(run_id), run_id, step_id, body)

    @app.websocket("/ws")
    async def serve_ws(ws: WebSocket) -> None:
        await _serve_ws(server, ws)

    return app


async def _serve_ws(server: Server, ws: WebSocket) -> None:
    """Connection lifecycle, query parsing, and the wire chaos knobs.

    The one hole in it is marked TASK below.

        GET /ws?run_id=r-1&resume_from=41

    resume_from is the last sequence number the client already has. It is 0 on a
    first connection.
    """
    run_id = ws.query_params.get("run_id", "")
    stream = server.streams.get(run_id)
    if stream is None:
        await ws.close(code=1008)
        return

    # SOCKET_REJECT_MS: stay unreachable for a while after dropping someone, so
    # the run genuinely moves on without them.
    if asyncio.get_running_loop().time() < server._open_from:
        await ws.close(code=1013)
        return

    try:
        resume_from = int(ws.query_params.get("resume_from", "0"))
    except ValueError:
        resume_from = 0

    await ws.accept()
    sub = await stream.subscribe(resume_from)
    deadline = None
    if server.cfg.socket_kill_ms > 0:
        deadline = asyncio.get_running_loop().time() + server.cfg.socket_kill_ms / 1000

    try:
        if sub.gap:
            # ---------------------------------------------------------------
            # TASK. The client asked to resume from a position the buffer no
            # longer holds, so some of the run happened and nobody can replay
            # it.
            #
            # Sending nothing here is the same as pretending it did not happen:
            # the socket simply goes live, the client carries on from the next
            # event, and a failure and its retry are missing from the timeline
            # with nothing to say so. It looks correct and it is not.
            #
            # Decide what the client is told, and make sure the client can tell
            # this apart from a clean resume. The shape is yours.
            # ---------------------------------------------------------------
            pass

        for event in sub.backlog:
            await ws.send_json(event.as_dict())

        while True:
            queued: Event | None
            if deadline is not None:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    if server.cfg.socket_reject_ms > 0:
                        server._open_from = (
                            asyncio.get_running_loop().time() + server.cfg.socket_reject_ms / 1000
                        )
                    await ws.close(code=1001)
                    return
                try:
                    queued = await asyncio.wait_for(sub.queue.get(), timeout=remaining)
                except TimeoutError:
                    continue
            else:
                queued = await sub.queue.get()
            if queued is None:
                return
            await _send_with_chaos(server, ws, queued)
    except (WebSocketDisconnect, RuntimeError):
        return
    finally:
        sub.cancel()


async def _send_with_chaos(server: Server, ws: WebSocket, event: Event) -> None:
    """Apply DUPLICATE_PCT and REORDER_PCT on the wire, after sequence numbers
    have been assigned. This models a lossy network, not a bug in anyone's code,
    which is why it lives here and not in stream.py."""
    cfg = server.cfg
    if cfg.reorder_pct > 0 and random.randrange(100) < cfg.reorder_pct:
        server._held.append(event)
        if len(server._held) < 2:
            return
        held, server._held = server._held, []
        for e in reversed(held):
            await ws.send_json(e.as_dict())
        return

    await ws.send_json(event.as_dict())
    if cfg.duplicate_pct > 0 and random.randrange(100) < cfg.duplicate_pct:
        await ws.send_json(event.as_dict())
