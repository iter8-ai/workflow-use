# workflow-use (Reiterate fork)

## Setup UI (`ui/`) layout rules

- No source-code, license or "public project" footer or links in the setup UI. The repository is public and `README.md` carries the AGPL-3.0 notice; that is sufficient. `ui/e2e/agent-setup.spec.ts` fails if a footer or such link comes back.
- One top bar only: back arrow on the left, stepper centred, X close on the right. The Reiterate host (commercials-flow-editor) draws no toolbar above the iframe. Both buttons go through the setup's own leave confirmation.
- Every stage opens with the same `.stage-title` block (h2 above a one-line description, same font and position). New stages reuse it. The Test stage is the one exception: its description sits behind a `HelpTip` (?) next to the h2, to give the browser the height.
