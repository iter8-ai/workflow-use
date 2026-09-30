# Workflow Use recording service

This service records a user's browser demonstration in an ephemeral Browserbase session. It does not execute workflows or expose a CDP endpoint.

ICE calls the service with `X-Workflow-Key`, `x-organization`, and `x-user-email`. Set these exact environment variables before running it:

- `WORKFLOW_USE_SERVICE_KEY`, a non-empty shared key used by ICE.
- `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`.
- `BROWSERBASE_REGION`, optional, defaults to `eu-central-1`.
- `WORKFLOW_USE_HOST`, optional, defaults to `127.0.0.1`. Use `0.0.0.0` only in the container.
- `WORKFLOW_USE_PORT`, optional, defaults to `8090`.

The service runs one worker. Its recording TTL caps at 15 minutes, and Browserbase receives the same cap. It binds to loopback by default.

```bash
cd recording
uv sync --group dev
uv run playwright install chromium
WORKFLOW_USE_SERVICE_KEY=... uv run python -m workflow_use_recording
uv run pytest
```

Build and run the production image with one worker and a non-root user:

```bash
docker build -t workflow-use-recording .
docker run --rm -p 8090:8090 \
  -e WORKFLOW_USE_SERVICE_KEY \
  -e BROWSERBASE_API_KEY \
  -e BROWSERBASE_PROJECT_ID \
  workflow-use-recording
```

Captures remain only in process memory. A service restart loses active and stopped recordings. The API reports an unknown recording as unavailable or restarted rather than pretending it can recover it. A failed browser close remains pending and is retried by the running service; Browserbase's 15-minute keep-alive cap is the final cleanup fallback after process loss. The service does not persist Browserbase URLs, screenshots, or arbitrary CDP endpoints.

Users may sign in during a demonstration. The capture script never sends field values. Typing into a password field, or a field recognized as a username, one-time code, or token field, becomes a `credential` step whose value is only the kind (`username`, `password`, or `otp`). The typed username and password are read by a separate script in an isolated browser world (page scripts cannot see, call or tamper with it; only real user input counts), held separately in recorder memory, never in steps, and returned once in the `credentials` field of the `stop` response (`Cache-Control: no-store`) so the host can save them as encrypted agent parameters. They are dropped on delete or expiry and never logged. One-time codes expire, so they are not kept. A sign-in form inside a cross-site iframe (out-of-process frame) is not covered yet; the host then asks for the values in its dialog. Other typing becomes an `input` step with the typed text, and a dropdown choice becomes a `select_change` step with the chosen option's label, so the agent can repeat them. A field whose label looks like a secret is recorded as a credential step even if the page script missed it. Browserbase session recording and logs are disabled. There is no recoverable recording persistence.

`POST /recordings` accepts `{"url":"https://public.example"}`. `GET /recordings/{id}`, `POST /recordings/{id}/stop`, and `DELETE /recordings/{id}` require the same tenant and user that created the recording. Browserbase Live View links appear only while a recording is active and are not logged or persisted.

`GET /health` returns `{"status":"ok"}` without exposing configuration or credentials.
