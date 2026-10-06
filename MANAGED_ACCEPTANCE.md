# Managed acceptance fixture

Run the configured preparation, then `npm --prefix ui run serve:acceptance`.
The launcher serves the existing executable `hostPage` fixture and real Vite UI on
loopback. Its JSON receipt contains the actual URL, full SHA, tracked-dirty flag and
private port. Supply `EXPECTED_SHA` to require an exact clean candidate; the server
refuses mismatches. Default ports are isolated, explicit ports are strict, and
SIGINT/SIGTERM releases the listener. `/__acceptance` exposes the same provenance.

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
