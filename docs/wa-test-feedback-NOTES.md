# Web-agent setup test feedback notes

Date: 2026-10-01. Scope: workflow-use setup UI, branch `hermes/wa-test-feedback-ui`.

## Behavior and contract decisions

The test workbench shows browser screenshots, classified failures, the stopped step, editable instructions, and completion choices. Editing instructions or completion criteria invalidates the previous result. Email completion requires a successful engine run and a routed file from the current test; polling stops after three minutes, including when a host request hangs. Modern hosts provide the schedule dialog, while older hosts retain the inline schedule fallback.

- **Capability ambiguity:** shared design `2026-10-01-web-agent-test-feedback-design.md:65` requires hiding unsupported email/text choices, but slice-4 `2026-10-01-wa-feedback-4-setup-ui-design.md:8` specifies only `emailRoutes` and `chooseSchedule`. The UI uses `chooseSchedule` as bundled modern-host readiness for text. `ui/src/setup/host.ts:25` declares those flags; `ui/src/setup/AgentSetup.tsx:575` passes schedule readiness as `textAllowed`, and line 736 filters text choices. No additional wire capability was introduced.
- **Inline rewrites:** `ui/src/setup/AgentSetup.tsx:444` preserves click semantics and authored outcomes. Credential rewrites retain their saved kind and clear obsolete target/url fields; other non-click rewrites use the existing `agent` type and clear target/value/url. That type already exists at `ui/src/setup/compiler.ts:3`; explicit outcomes remain compiled at line 228.
- **Email cutoff:** `ui/src/setup/AgentSetup.tsx:400` captures the test start before awaiting startup. Lookup at line 227 uses that fixed cutoff. The deadline at line 223 prevents late results from reviving a timed-out or replaced test.
- **Human dialog timeout:** credential entry and schedule selection share the existing ten-minute allowance (`ui/src/setup/AgentSetup.tsx:23`, 358, 473).

Dependencies and merge order: [FIRE #950](https://github.com/iter8-ai/fire/pull/950) → [ICE #2010](https://github.com/iter8-ai/ice/pull/2010) → [CFE #1407](https://github.com/iter8-ai/commercials-flow-editor/pull/1407) → this workflow-use draft PR.

## Validation

Checks run in `ui/` unless stated otherwise:

- `npm test`: **22 passed, 0 failed**, exit 0 (`ui/e2e-artifacts/review-fix-unit.log`).
- `npx tsc --noEmit -p .`: exit 0 (`ui/e2e-artifacts/typecheck-final-green.log`).
- `npm run lint`: exit 0 (`ui/e2e-artifacts/lint-final-green.log`).
- `npx playwright test --reporter=line`: **34 passed (16.2s)**, exit 0 (`ui/e2e-artifacts/playwright-acceptance.log`).
- `graphify update .` at the repository root: exit 0 (`ui/e2e-artifacts/graphify-final-green.log`).

Compiler and browser regressions were observed failing before their fixes. Coverage includes completion stages, credential disclosure, failed-step rewrites, validation recovery, email arrival cutoff and timeout, legacy-host behavior, slow schedule selection, and layout at 1440×900 and 480 px wide. All 14 generated screenshots were inspected against the prototype layout and copy; the fake host uses synthetic browser images. These checks do not establish deployed CFE/FIRE/ICE integration or staging email delivery.

## Boundaries and deviations

- The prototype HTML and all 11 reference PNGs were read. Chrome denied navigation to the prototype file URL; no alternate route bypassed that denial.
- Explainer publication is blocked by the worktree-only write boundary: the required workflow writes to a separate docs repository. No explainer was published.
- Vite bundled its config through the shared `node_modules` symlink into `.vite-temp`, producing EPERM (`ui/e2e-artifacts/custom-proof/red-startup.log`). `ui/package.json:6` now uses `vite --configLoader runner`, and `ui/vite.config.ts:8` keeps its cache inside this worktree. Startup succeeded with that configuration. No dependencies were added or shared caches deleted.
- Temporary proof files were briefly written under `/tmp/wa-custom-done-proof`, then moved into `ui/e2e-artifacts/custom-proof`; the external directory was removed.
- No repository-local guidelines directory was present. Ancestor workspace guidance and the approved contracts were followed.
