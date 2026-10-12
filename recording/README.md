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

`POST /recordings` accepts a public HTTP(S) URL without embedded username or password, including a deep link such as `{"url":"https://public.example/reports?month=2026-10#summary"}`. Paths, queries, and fragments are allowed; the service passes the full URL as entered to the browser. Before contacting Browserbase, the service resolves the URL host and requires every returned address to be public. Resolution failure, a two-second timeout, no addresses, or any nonpublic address returns HTTP 422 with `detail` `The recording URL host {hostname} could not be resolved to a public address.` The error names only the hostname, with no other URL content. Browser navigation events with a nonempty query or fragment are omitted as whole steps so redirect tokens are not saved in the recording. `GET /recordings/{id}`, `POST /recordings/{id}/navigate`, `POST /recordings/{id}/stop`, and `DELETE /recordings/{id}` require the same tenant and user that created the recording. Browserbase Live View links appear only while a recording is active and are not logged or persisted.

If the initial page navigation raises a Playwright error after the browser starts, the provider keeps the session open with `startPageFailed: true`. `POST /recordings` returns 201 if that session is still active when attached; the original recording expiry still applies, and startup after expiry can return 503. Failed startup skips only the synthetic fallback step for the configured URL. Browser navigation events remain authoritative and may already have added steps before the error.

`POST /recordings/{id}/navigate` accepts the same URL format, opens the page in the live view tab, and returns 200 with the recording. A successful navigation clears `startPageFailed`; when recorded, its step comes from the browser navigation event and follows the query and fragment omission rule above. A public HTTP(S) main-page `DOMContentLoaded` in any captured tab also clears the flag, except on Google sign-in pages. That browser-only load event adds no step, and page JavaScript cannot forge it through the capture binding.

Navigation recovery applies only when Playwright reports `interrupted by another navigation to "chrome-error://chromewebdata/"`. After each such interruption, including the third attempt, the provider waits for `DOMContentLoaded`, ignores Playwright errors from that wait, and accepts the current URL if it matches the target after removing trailing slashes. Otherwise it retries, up to three navigation attempts, then raises the last interruption. Other Playwright errors are raised unchanged by the provider.

Navigate returns 404 for an unknown or foreign recording, 409 for an inactive recording with a valid URL, and 422 for an invalid or nonpublic URL or a Playwright navigation-operation failure. The latter has detail `The page could not be opened.` Other failures return 503 with generic detail `Recording service is temporarily unavailable.` The provider logs `recording_start_page_failed error_type=<type>`, the service logs `recording_navigate_failed error_type=<type>` for Playwright navigation failures, and the API logs `recording_navigate_error error_type=<type>` for 503 failures. These WARNING diagnostics contain no exception messages or tracebacks.

An invalid recording URL returns HTTP 422. Other recording startup failures return HTTP 503 with `{"detail":"Recording service is temporarily unavailable."}`. During Browserbase context or session creation and browser setup, the provider logs a WARNING `recording_browser_start_failed stage=<stage> error_type=<type>` if startup fails. The API logs a WARNING `recording_start_failed error_type=<type>` for startup failures that return 503. These diagnostics omit exception messages and tracebacks because a Browserbase connect URL can contain a signing key.

`GET /health` returns `{"status":"ok"}` without exposing configuration or credentials.
