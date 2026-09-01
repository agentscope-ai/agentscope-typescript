/** Standalone Python MCP gateway copied into sandbox workspaces. */
export const GATEWAY_PYTHON_SCRIPT = String.raw`import argparse
import asyncio
import secrets
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse
from agentscope.mcp import MCPClient


class State:
    def __init__(self) -> None:
        self.clients = {}
        self.lock = asyncio.Lock()


async def build_client(spec):
    client = MCPClient.model_validate(spec)
    if client.is_stateful:
        await client.connect()
    await client.list_raw_tools()
    return client


def build_app(state, auth_token=None, instance_nonce=None):
    app = FastAPI(title="agentscope-workspace-mcp-gateway")

    def lookup(agent_id, session_id, name):
        client = state.clients.get((agent_id, session_id), {}).get(name)
        if client is None:
            raise HTTPException(404, repr(name) + " not found")
        return client

    if auth_token:
        @app.middleware("http")
        async def auth(request: Request, call_next: Any):
            if request.url.path == "/health":
                return await call_next(request)
            header = request.headers.get("authorization", "")
            expected = "Bearer " + auth_token
            valid = header.isascii() and expected.isascii() and secrets.compare_digest(header, expected)
            if not valid:
                return PlainTextResponse("invalid gateway token", status_code=401)
            return await call_next(request)

    @app.get("/health", response_model=None)
    async def health():
        if instance_nonce is not None:
            return {"status": "ok", "instance_nonce": instance_nonce}
        return PlainTextResponse("ok")

    @app.get("/mcps")
    async def list_mcps(agent_id: str = "", session_id: str = ""):
        return [c.model_dump(mode="json") for c in state.clients.get((agent_id, session_id), {}).values()]

    @app.post("/mcps")
    async def add_mcp(request: Request, agent_id: str = "", session_id: str = ""):
        body = await request.json()
        name = body.get("name", "")
        if not name:
            raise HTTPException(400, "name required")
        async with state.lock:
            clients = state.clients.setdefault((agent_id, session_id), {})
            if name in clients:
                raise HTTPException(409, repr(name) + " already exists")
            try:
                clients[name] = await build_client(body)
            except Exception as exc:
                raise HTTPException(500, "connect failed: " + str(exc)) from exc
        return {"ok": True}

    @app.delete("/mcps/{name}")
    async def remove_mcp(name: str, agent_id: str = "", session_id: str = ""):
        async with state.lock:
            client = lookup(agent_id, session_id, name)
            del state.clients[(agent_id, session_id)][name]
            if not state.clients[(agent_id, session_id)]:
                del state.clients[(agent_id, session_id)]
            if client.is_stateful and client.is_connected:
                await client.close()
        return {"ok": True}

    @app.get("/mcps/{name}/tools")
    async def list_tools(name: str, agent_id: str = "", session_id: str = ""):
        raw = await lookup(agent_id, session_id, name).list_raw_tools()
        return [tool.model_dump(mode="json") for tool in raw]

    @app.post("/mcps/{name}/tools/{tool}")
    async def call_tool(name: str, tool: str, request: Request, agent_id: str = "", session_id: str = ""):
        client = lookup(agent_id, session_id, name)
        arguments = (await request.json()).get("arguments") or {}
        try:
            chunk = await (await client.get_tool(tool))(**arguments)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(500, str(exc)) from exc
        return {"chunk": chunk.model_dump(mode="json")}

    return app


async def run(port, auth_token=None, instance_nonce=None):
    state = State()
    app = build_app(state, auth_token, instance_nonce)
    import uvicorn
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="info"))
    try:
        await server.serve()
    finally:
        for clients in state.clients.values():
            for client in clients.values():
                if client.is_stateful and client.is_connected:
                    await client.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=None)
    parser.add_argument("--port", type=int, default=5600)
    parser.add_argument("--auth-token")
    parser.add_argument("--instance-nonce")
    args = parser.parse_args()
    asyncio.run(run(args.port, args.auth_token, args.instance_nonce))


if __name__ == "__main__":
    main()
`;
