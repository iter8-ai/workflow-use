# Workflow Use recording service

In production, this service records a user's browser demonstration in an ephemeral Browserbase session. It does not execute workflows or expose a CDP endpoint.

ICE calls the service with `X-Workflow-Key`, `x-organization`, and `x-user-email`. Set these environment variables for the production Browserbase provider:

- `WORKFLOW_USE_SERVICE_KEY`, a non-empty shared key used by ICE.
- `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`.
- `BROWSERBASE_REGION`, optional, defaults to `eu-central-1`.
- `BROWSERBASE_PROXY_COUNTRY`, optional, an ISO 3166-1 alpha-2 code, defaults to `EE`: where the residential proxy exits when a site blocks the direct browser (see "Blocked start pages"). An invalid value fails startup; an empty one means the default.
- `WORKFLOW_USE_HOST`, optional, defaults to `127.0.0.1`. Use `0.0.0.0` only in the container.
- `WORKFLOW_USE_PORT`, optional, defaults to `8090`.

The service runs one worker. Its recording TTL caps at 15 minutes, and Browserbase receives the same cap. Creating a recording has a separate 45-second browser startup deadline; a create that misses it releases the browser and Browserbase session and returns HTTP 504 with `The recording start page did not load in time.` A direct start page navigation eligible for proxy retry has a 20-second timeout; a borrowed-context navigation and the final proxied navigation use a 45-second timeout. The overall startup deadline bounds all attempts. Browser setup and cleanup also take time, so the 45-second deadline can expire before both direct and proxied attempts finish. It binds to loopback by default.

```bash
cd recording
uv sync --group dev
uv run playwright install chromium
WORKFLOW_USE_SERVICE_KEY=... uv run python -m workflow_use_recording
uv run pytest
```

For local gate validation, `scripts/gate-test.sh serve` runs the recorder with the local Playwright provider in the installed Google Chrome. See [`.no-mistakes.yaml`](../.no-mistakes.yaml) for gate commands and live validation instructions.

Build and run the production image with one worker and a non-root user:

```bash
docker build -t workflow-use-recording .
docker run --rm -p 8090:8090 \
  -e WORKFLOW_USE_SERVICE_KEY \
  -e BROWSERBASE_API_KEY \
  -e BROWSERBASE_PROJECT_ID \
  workflow-use-recording
```

The [production image workflow](../.github/workflows/build-production-images.yml) runs on pushes to `main` that change `recording/**` or the workflow file. It builds or reuses the immutable `workflow-use-recording-default` ECR image tagged with the full commit SHA, then sends a `deploy-services` repository dispatch to the infrastructure repository with both group and service set to `workflow-use-recording`. It skips dispatch for an older SHA if a later `main` commit changed the recorder or this workflow. A manual `workflow_dispatch` on `main` builds or reuses the image only; it does not dispatch a deploy.

The workflow requires the repository variable `AWS_PRODUCTION_ECR_PUSH_ROLE_ARN` and secret `INFRA_REPOSITORY_DISPATCH_TOKEN`. It checks for the secret even on manual recording builds. A successful dispatch confirms the request was sent, not that the infrastructure rollout finished or the live service is running the image; check those separately.

Captures remain only in process memory. A service restart loses active and stopped recordings. The API reports an unknown recording as unavailable or restarted rather than pretending it can recover it. A failed browser close remains pending and is retried by the running service; Browserbase's 15-minute keep-alive cap is the final cleanup fallback after process loss. The service does not persist Browserbase URLs, screenshots, or arbitrary CDP endpoints.

Users may sign in during a demonstration. The capture script never sends credential field values. Typing into a password field, or a field recognized as a username, one-time code, or token field, becomes a `credential` step whose value is only the kind (`username`, `password`, or `otp`). The typed username and password are read by a separate script in an isolated browser world (page scripts cannot see, call or tamper with it; only real user input counts), held separately in recorder memory, never in steps, and returned once in the `credentials` field of the `stop` response (`Cache-Control: no-store`) so the host can save them as encrypted agent parameters. They are dropped on delete or expiry and never logged. One-time codes expire, so they are not kept. A sign-in form inside a cross-site iframe (out-of-process frame) is not covered yet; the host then asks for the values in its dialog. Other typing becomes an `input` step with the typed text, and a dropdown choice becomes a `select_change` step with the chosen option's label, so the agent can repeat them. A field whose label looks like a secret is recorded as a credential step even if the page script missed it. Browserbase session recording, logs and automatic captcha solving are disabled: a person is in the live view and solves challenges, and the solver would fight them (it starts on its own on reCAPTCHA sign-in pages and fails). There is no recoverable recording persistence.

`POST /recordings` accepts a public HTTP(S) URL without embedded username or password, including a deep link such as `{"url":"https://public.example/reports?month=2026-10#summary"}`. Paths, queries, and fragments are allowed; the service passes the full URL as entered to the browser. Before contacting Browserbase, the service resolves the URL host and requires every returned address to be public. Resolution failure, a two-second timeout, no addresses, or any nonpublic address returns HTTP 422 with `detail` `The recording URL host {hostname} could not be resolved to a public address.` The error names only the hostname, with no other URL content. Recorded browser navigation steps retain the full public URL, including its query and fragment. `GET /recordings/{id}`, `POST /recordings/{id}/navigate`, `POST /recordings/{id}/stop`, and `DELETE /recordings/{id}` require the same tenant and user that created the recording. Browserbase Live View links appear only while a recording is active and are not logged or persisted.

A demonstration can start from a saved sign-in with two optional fields; without them nothing changes:

```json
{
  "url": "https://app.example.com",
  "context_id": "<browserbase-context-id>",
  "login": {
    "origins": ["https://login.example.com"],
    "username": "person@example.com",
    "password": "<password>"
  }
}
```

- `context_id` is a Browserbase context that holds a saved Google session. The browser opens it with `persist: true`, so website sign-ins demonstrated by the user are saved back to that credential's shared context when the session ends. Agents already authorized to the same saved credential reuse those sign-ins until the website expires or revokes them. ICE must resolve the context from the caller's authorized credential; this field does not authorize access to another credential or tenant. The service creates no context of its own. The context is borrowed: no stop, delete, expiry, eviction, shutdown or startup-failure path deletes it, and `POST /recordings/{id}/google-context` returns 409 `google_context_unavailable` for such a recording. The local Playwright provider ignores it with a WARNING `recording_saved_context_ignored`.
- `login` holds 1 to 10 `origins` (`scheme://host[:port]`, no path; compared lowercase, default port dropped), an optional `username` and a required `password`, each at most 2000 characters. When a page or frame on one of those origins shows a sign-in form, the browser fills each empty, visible username or password field once, using the capture script's field classification, also on a two-step sign-in and in popups. Filling continues on matching pages and frames throughout the open recording, including after navigation. It does not submit or advance sign-in forms or wait for authentication before handing over the live browser. New-password, one-time-code and other secret fields, and forms that contain a new-password field, are not filled. The fill is not user input: it adds `credential` steps (kind only) but never reaches `credentials` on stop. The values are never logged, returned, or put in steps or events; the browser session drops them when the recording ends. Validation errors (422) on this endpoint omit the rejected input.

The saved context is a full browser profile. Google sign-out or switching Google accounts during a demonstration can change the Google session for every agent authorized to the same credential. At close, the recorder checks only for a qualifying Google session cookie; it does not verify that the account still matches the previously connected identity. This shared-profile behavior is also used by normal FIRE runs, so credential owners must treat account changes as changes to the shared session.

The single recorder worker rejects a second active demonstration using the same saved context with the existing generic 503 startup response. The reservation covers startup and failed/retried closes. It does not coordinate with FIRE runs, Google reconnect sessions, another worker, or a session left running after a process/startup-cleanup failure. Those users of a shared credential need exclusion at the credential-owning service before opening a Browserbase session, through release and synchronization. Concurrent profile writers can overwrite each other's sign-in changes; do not run them together.

Stop awaits Browserbase's `REQUEST_RELEASE` request before returning. This is not a context synchronization acknowledgement. [Browserbase's context guide](https://docs.browserbase.com/platform/browser/core-features/contexts) says saving happens at session end and synchronization takes a few seconds. The public [Get Context API](https://docs.browserbase.com/reference/api/get-a-context) exposes `updatedAt`, but does not define it as a save-complete acknowledgement for a particular session. Session `COMPLETED` likewise has no documented context-upload guarantee. The recorder does not invent a readiness guarantee or add an arbitrary sleep. Immediate Stop → Test must be checked with the real provider; reliable cross-service scheduling/readiness remains a credential-owner integration boundary.

## Blocked start pages

Some sites answer the start page's main document with HTTP 403, 429 or 503. Playwright may load that response, so the recorder treats the status as "blocked by site". Then, when the recording uses a context of its own, the provider releases that session, deletes the context it created (the same cleanup as any startup failure) and starts one more session, identical except that its traffic exits through Browserbase's residential proxy: `proxies=[{"type": "browserbase", "geolocation": {"country": <country>}}]`. The country is the request's optional `country` field (ISO 3166-1 alpha-2, 422 otherwise; upper-cased), else `BROWSERBASE_PROXY_COUNTRY`, else `EE`. There is one retry. If the proxied session is blocked too, it stays open on the block page, so the person can open another page, and the recording is marked blocked.

A demonstration that borrows a saved sign-in `context_id` is not retried: Browserbase lets one session hold a context at a time, and the released session may still be shutting down when the retry would open the same context again. Such a recording stays on its direct session and is marked blocked. If deleting the blocked attempt's context fails, the create fails like any other startup failure with a pending context cleanup (503) instead of retrying. Later blocks update `startPageBlocked` but do not trigger a proxy retry; navigation transport errors, including `ERR_TUNNEL_CONNECTION_FAILED`, do not trigger one either.

Successful recording responses, including stop, carry these fields:

- `startPageBlocked`, true while the site answers the shown page with a block status. A loaded public main page in any captured tab clears it automatically unless it is a Google sign-in page or a block page. A successful `navigate` clears it if the destination is not blocked. A block can also land after the create response: Akamai lets the first document through, its challenge script re-requests the page about a second later, and that request gets 403. The recorder reports such a main-document block on a captured tab as `startPageBlocked: true` on the next poll, so the host's hint does not depend on when the block arrived.
- `network`, `"direct"` or `"proxy"`: the network the demonstration browser is on. The stop response carries it too, so the host saves it on the agent and its runs use the same network.
- `proxyCountry`, the proxy's country code, or `null` on a direct session.

```json
{"url": "https://www.example.com/en", "country": "DE"}
```

The provider logs only `recording_start_page_blocked status=<int> network=<direct|proxy>` for each blocked start attempt, never the URL or provider messages. The local Playwright provider reports a block but has no proxy to retry over.

Observed on 2026-10-19 against godaddy.com from eu-central-1, in small samples: the direct recorder session was answered 403 at once in some rounds and loaded in others; the proxied retry loaded the first document (200, Akamai's "Loading …" challenge page) and then either the real page or a 403 on the challenge's re-request, which the recorder reports as `startPageBlocked: true`. Akamai's verdict is stateful per address and flipped within minutes between rounds. These probes predate the switch from a Playwright binding to console-message capture. Split probes without the recorder's route interception, capture script and binding passed more often, so the instrumentation used then is a suspected contributor, not an isolated cause; measure with six or more interleaved rounds using the current console-message capture before changing the route guard or the capture script on that basis. The retry helps sites that block by address.

If the initial page navigation raises a Playwright error after the browser starts, the provider keeps the session open with `startPageFailed: true`. A navigation timeout instead fails the create with the startup deadline's 504. `POST /recordings` returns 201 if a session with a non-timeout navigation error is still active when attached; the original recording expiry still applies, and startup after expiry can return 503. Failed startup skips only the synthetic fallback step for the configured URL. Browser navigation events remain authoritative and may already have added steps before the error.

`POST /recordings/{id}/navigate` accepts the same URL format, opens the page in the live view tab, and returns 200 with the recording. A successful navigation clears `startPageFailed`; see "Blocked start pages" for how it updates `startPageBlocked`. When recorded, its step comes from the browser navigation event and retains the full public URL. A public HTTP(S) main-page `DOMContentLoaded` in any captured tab also clears `startPageFailed`, except on Google sign-in or blocked pages. That browser-only load event adds no step, and page JavaScript cannot forge it through the capture console messages.

Navigation recovery applies only when Playwright reports `interrupted by another navigation to "chrome-error://chromewebdata/"`. After each such interruption, including the third attempt, the provider waits for `DOMContentLoaded`, ignores Playwright errors from that wait, and accepts the current URL if it matches the target after removing trailing slashes. Otherwise it retries, up to three navigation attempts, then raises the last interruption. Other Playwright errors are raised unchanged by the provider.

Navigate returns 404 for an unknown or foreign recording, 409 for an inactive recording with a valid URL, and 422 for an invalid or nonpublic URL or a Playwright navigation-operation failure. The latter has detail `The page could not be opened.` Other failures return 503 with generic detail `Recording service is temporarily unavailable.` The provider logs `recording_start_page_failed error_type=<type>`, the service logs `recording_navigate_failed error_type=<type>` for Playwright navigation failures, and the API logs `recording_navigate_error error_type=<type>` for 503 failures. These WARNING diagnostics contain no exception messages or tracebacks.

An invalid recording URL returns HTTP 422. Other recording startup failures return HTTP 503 with `{"detail":"Recording service is temporarily unavailable."}`. During Browserbase context or session creation and browser setup, the provider logs a WARNING `recording_browser_start_failed stage=<stage> error_type=<type>` if startup fails. The API logs a WARNING `recording_start_failed error_type=<type>` for startup failures that return 503. These diagnostics omit exception messages and tracebacks because a Browserbase connect URL can contain a signing key.

`GET /health` returns `{"status":"ok"}` without exposing configuration or credentials.
