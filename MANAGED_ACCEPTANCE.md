# Managed acceptance fixture

Run the configured preparation, then `npm --prefix ui run serve:acceptance`.
The launcher serves the existing executable `hostPage` fixture and real Vite UI on
loopback. Its JSON receipt contains the actual URL, full SHA, tracked-dirty and
untracked-dirty flags, and private port. Supply `EXPECTED_SHA` to require an exact
clean candidate; the server refuses mismatches and nonignored untracked files.
Each launcher owns one loopback HTTP listener for pages and Vite WebSockets.
Default ports are isolated, explicit ports are strict, and SIGINT/SIGTERM closes
WebSocket clients and releases the listener. `/__acceptance` exposes the same provenance.

Open `/host` on the receipt's URL. It redirects to `?scenario=success`; select another
scenario with `/host?scenario=<name>` from [the executable fixture](ui/e2e/agent-setup.spec.ts).
To request an HTTP port, run `npm --prefix ui run serve:acceptance -- --port <port>`;
`0` selects an available port, and explicit ports must be between 1024 and 65535.
`EXPECTED_SHA` must be a full 40-character hexadecimal SHA. On each HTTP request,
the launcher checks HEAD, tracked changes, and nonignored untracked file paths and
contents against startup. A detected change or failed source check makes subsequent
requests return HTTP 409 until restart, even if the source is restored. Ignored
dependency and generated files are excluded. `trackedDirty` retains its tracked-only
meaning; `untrackedDirty` reports the additional source state.

The hidden `#acceptance-audit` mirrors actual method/read/close/test/save/stop arrays.
Missing instrumentation is `null`, never a fabricated zero. The host's responses,
screens and links are fake-fixture evidence. Use its existing run scenarios for
fixed identity, browser/activity lifecycle, read-only controls, polling recovery,
startup retry/close/back, and viewport checks; use create/edit scenarios for regressions.

This fixture does not prove real provider behavior, CFE parent unmount, or
mixed-version compatibility. Configured unit suites alone cannot clear browser
acceptance. Paired changes require current combined pins and both mixed-version
directions, conservative old-host refusal, instruction/doneWhen and email-arrival
preservation. Missing companion/provider proof is blocked or inconclusive.
After rebase, rerun relevant Chrome checks on the new pins before handing off or merging.
