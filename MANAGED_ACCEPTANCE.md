# Managed acceptance fixture

Run the configured preparation, then `npm --prefix ui run serve:acceptance`.
The launcher serves the existing executable `hostPage` fixture and real Vite UI on
loopback. Its JSON receipt contains the actual URL, full SHA, tracked-dirty flag and
private port. Supply `EXPECTED_SHA` to require an exact clean candidate; the server
refuses mismatches. Default ports are isolated, explicit ports are strict, and
SIGINT/SIGTERM releases the listener. `/__acceptance` exposes the same provenance.

Open `/host` on the receipt's URL. It redirects to `?scenario=success`; select another
scenario with `/host?scenario=<name>` from [the executable fixture](ui/e2e/agent-setup.spec.ts).
To request an HTTP port, run `npm --prefix ui run serve:acceptance -- --port <port>`;
`0` selects an available port, and explicit ports must be between 1024 and 65535.
`EXPECTED_SHA` must be a full 40-character hexadecimal SHA. On each HTTP request,
the launcher checks HEAD and tracked changes against startup. A detected change or
failed source check makes subsequent requests return HTTP 409 until restart,
even if the source is restored. Untracked files are excluded from these checks.

The hidden `#acceptance-audit` mirrors actual method/read/close/test/save/stop arrays.
Missing instrumentation is `null`, never a fabricated zero. The host's responses,
screens and links are fake-fixture evidence. Use its existing run scenarios for
fixed identity, browser/activity lifecycle, read-only controls, polling recovery,
startup retry/close/back, and viewport checks; use create/edit scenarios for regressions.

This fixture is not a real CFE host or provider. Configured unit suites alone cannot
clear browser acceptance. Paired changes require current combined pins and both
mixed-version directions, conservative old-host refusal, instruction/doneWhen and
email-arrival preservation. Missing companion/provider proof is blocked or inconclusive.
After rebase, rerun relevant Chrome checks on the new pins before handing off or merging.
