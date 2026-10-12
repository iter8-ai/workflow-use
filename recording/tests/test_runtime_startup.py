from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def test_missing_playwright_driver_keeps_process_output_generic() -> None:
    script = '''
import json
import logging
import sys
from types import ModuleType, SimpleNamespace

from fastapi.testclient import TestClient
from workflow_use_recording.api import RecordingConfig, create_app
from workflow_use_recording.provider import BrowserbaseProvider

calls = []
class Client:
    def __init__(self):
        self.contexts = SimpleNamespace(create=self.create_context)
        self.sessions = SimpleNamespace(create=self.create_session, debug=self.debug, update=self.update)

    async def create_context(self, **kwargs):
        calls.append("create_context")
        return SimpleNamespace(id="context-private")

    async def create_session(self, **kwargs):
        calls.append("create_session")
        return SimpleNamespace(id="session-private", connect_url="wss://example.com/?signingKey=must-not-leak")

    async def debug(self, session_id):
        calls.append("debug_session")
        return SimpleNamespace(debugger_fullscreen_url="https://example.com/live")

    async def update(self, *args, **kwargs):
        calls.append("release_session")

    async def delete(self, *args, **kwargs):
        calls.append("delete_context")

    async def __aexit__(self, *args):
        calls.append("client_exit")

browserbase = ModuleType("browserbase")
browserbase.AsyncBrowserbase = Client
sys.modules["browserbase"] = browserbase
logging.basicConfig(level=logging.WARNING)
with TestClient(create_app(BrowserbaseProvider(project_id="project-private"), RecordingConfig(service_key="test-key"))) as http:
    response = http.post("/recordings", json={"url": "https://example.com"}, headers={
        "X-Workflow-Key": "test-key", "x-organization": "test-org", "x-user-email": "test@example.com"})
print("RESULT=" + json.dumps({"status": response.status_code, "body": response.json(), "calls": calls}))
'''
    env = os.environ.copy()
    env["PLAYWRIGHT_NODEJS_PATH"] = str(Path(__file__).resolve().parents[1] / "missing-driver-must-not-leak")
    result = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True, timeout=20)

    assert result.returncode == 0, result.stderr
    outcome = json.loads(result.stdout.removeprefix("RESULT="))
    assert outcome["status"] == 503
    assert outcome["body"] == {"detail": "Recording service is temporarily unavailable."}
    assert outcome["calls"] == [
        "create_context", "create_session", "debug_session", "release_session", "delete_context", "client_exit"
    ]
    assert "recording_browser_start_failed stage=start_runtime error_type=FileNotFoundError" in result.stderr
    assert "recording_start_failed error_type=FileNotFoundError" in result.stderr
    assert "Traceback" not in result.stdout + result.stderr
    assert "must-not-leak" not in result.stdout + result.stderr
