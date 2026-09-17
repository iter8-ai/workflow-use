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

Never enter passwords, one-time codes, API keys, session tokens, or other secrets in a demonstration. The recorder blocks values from password fields and fields it recognizes as credential-related, but that detection is heuristic and cannot identify every unmarked secret field. Credential demonstrations remain unsupported. Private login uses a separate uncaptured browser and never becomes a demonstration step. There is no recoverable recording persistence.

`POST /recordings` accepts `{"url":"https://public.example"}`. `GET /recordings/{id}`, `POST /recordings/{id}/stop`, and `DELETE /recordings/{id}` require the same tenant and user that created the recording. Browserbase Live View links appear only while a recording is active and are not logged or persisted.

`GET /health` returns `{"status":"ok"}` without exposing configuration or credentials.

## Private login preparation

`POST /recordings` also accepts `{"url":"https://public.example/login","privateLogin":true}`. The optional `Idempotency-Key` header binds a create retry to the same owner and request while its record remains in memory. A different request using the same key returns 409. In-progress retries return 409.

The private flow has these states:

1. `awaiting_login`: the host opens `GET /recordings/{id}/private-view`, which returns only `{"liveViewUrl":"..."}`. The user logs in manually. No capture script or event binding is installed.
2. `POST /recordings/{id}/prepare` with `{"url":"https://public.example/reports"}` creates a fresh browser and transfers only cookies applicable to the approved host. Parent-domain cookies are narrowed to that host; partitioned cookies, local storage, session storage, and history are not transferred. The exact post-login URL must be public, same-origin, and contain no query or fragment. The original login session stays open until activation.
3. `verifying_login`: the private-view endpoint now points at the fresh session. The user checks that the page is logged in. Status polling remains available while the user checks.
4. `POST /recordings/{id}/activate` is the user's confirmation. It closes the login session, installs capture in the fresh session, resets the steps, and enters `recording`. It does not detect or claim authentication automatically.

Prepare and activate retries are idempotent for the same prepared URL. Wrong-state operations return 409, rejected URLs return 422, and missing recordings or wrong owners return 404. Stop, delete, failure, shutdown, and expiry close both sessions; failed closes remain eligible for retry. Pending private sessions count against capacity and share the original 15-minute TTL.

Public responses include `liveViewUrl` only in `recording`; private states expose no steps or URL there. Private-view links are owner-bound bearer capabilities and must stay in the host's private login UI. The private-view endpoint returns 409 outside `awaiting_login` and `verifying_login`. Both response types use `Cache-Control: no-store`. Request bodies never accept cookies, provider IDs, or CDP URLs.

Browserbase recording and logging stay disabled in both sessions. Private sessions and their activated recordings reject page navigation beyond the approved origin, including popups and frames. Public CDN subresources are allowed after the existing public-host check. Cross-origin SSO and authentication held only in browser storage are unsupported by this cookie-only flow.

This prepares a recording only. A future saved workflow must test its separately supplied credentials in a fresh FIRE execution session before claiming it can log in.
