# Agent setup host contract

Embed the UI in an iframe with `parentOrigin` set to the host origin. The UI accepts responses only from that exact origin and its parent window. Hosts must accept requests only from their configured UI origin and the iframe window.

Requests use `{type: "workflow-use:request", version: 1, id, method, params}`. Responses echo the id with `{type: "workflow-use:response", version: 1, id, result}` or a user-safe `error` string. Do not send authentication tokens, service keys, or private execution credentials in either direction.

| Method | Parameters | Result |
| --- | --- | --- |
| ready | empty object | See `RequestMap["ready"]["result"]` in [host.ts](../ui/src/setup/host.ts). |
| startRecording | `url` | Recording |
| getRecording / stopRecording | `id` | Recording |
| cancelRecording | `id` | null |
| requestCredentials | `kinds`, optional `replace` | `{saved: kinds}` |
| saveAgent | `draft`, `config`, optional `agentId` | `{id}` |
| loadRun | empty object | See `WatchedRun` in [host.ts](../ui/src/setup/host.ts). |
| testAgent | `agentId`, `arguments: {}` | `{id}` |
| getTestRun | `agentId`, `runId` | `{status, stopping?, error?, files?, liveViewUrl?, failure?, stoppedAtStep?, confirmation?, screens?, activity?}` |
| stopTest | `agentId`, `runId` | null |
| createEmailRoute | `name` | `{channelId, address}` |
| getEmailArrival | `channelId`, `since` (test-start ISO timestamp) | `{status: "waiting" \| "routed" \| "rejected" \| "no_documents", from?, files?}` |
| allowEmailSender | `channelId`, `sender` | null |
| chooseSchedule | `cron` | `{cron}` or null on cancel |
| scheduleAgent | `agentId`, `runId`, `arguments: {}`, `cron` | null |
| close | optional `agentId` | null |

The TypeScript shapes are in [host.ts](../ui/src/setup/host.ts). Recording statuses are recording, stopped, and expired. Test statuses are running, succeeded, and failed. Cron expressions have five fields and use UTC.

For an existing run, open the iframe with `mode=run` and return `mode: "run"` from `ready`. The host chooses the agent and run, then binds both IDs in `loadRun`; the iframe supplies neither ID to that request. Return the current `TestRun` with `loadRun` and accept `getTestRun` only for the bound IDs. The page polls that run while it is running and shows its browser screenshots, activity, status, and final evidence. Back and close exit the observer; reload watches the same host-bound run again. None of these actions, or navigating away, may start, stop, delete, save, publish, or schedule the run. A failed `ready` or `loadRun` request leaves the page on a retry or close screen, not in the creation flow. The host's `close` response exits the observer without changing the run.

Deploy the matching `commercials-flow-editor` host support for `mode=run` and `loadRun` before deploying the setup UI with run inspection.

Start URLs must omit query parameters, fragments, and embedded credentials. The host binds saved configurations to the successfully recorded starting URL and requires a stopped, unblocked recording. The host owns access control and validates every request independently. It must bind recording operations to the authenticated tenant and user, bind agent operations to the current setup, and reject scheduling unless the latest saved version passed a test. Duplicate request ids should reuse the same response. Closing setup must close any active recording. The host may open the saved agent after closing, but must select it from its own setup state rather than trust the optional agentId in the close request. Closing alone does not attest that a test passed or that the user reviewed its result.

Treat all draft text and recorded page content as untrusted. The compiler emits semantic computer-use stages, not DOM selectors or a browser-use execution loop. Demonstrated form entry is repeated with the exact recorded values; reusable per-run inputs are not supported. Test and schedule requests must carry an exact empty `arguments` object.

## Sign-in details

Recording steps never contain sign-in values; a `credential` step records only the kind (`username`, `password`, or `otp`). The recording service's `POST /recordings/{id}/stop` response additionally carries `credentials: {username?, password?}`, the values typed into the demonstrated sign-in form, exactly once and with `Cache-Control: no-store`. This is a service-to-host field: the host must keep it, save it as the agent's encrypted parameters, and strip it before answering the iframe's `stopRecording`, whose Recording result has no credentials. Discarding the recording (`cancelRecording`) must discard the values captured by it.

`requestCredentials` asks the host to make sure the listed kinds are saved. The host asks the user in its own UI only for kinds it does not hold (typically the authenticator key for a one-time code), or for all listed kinds when `replace` is true, and answers with the kinds that are saved, never the values. Hosts that return `credentials: false` (or omit it) from `ready` cannot store sign-in details, and the UI will not test an agent that needs them.

## Test feedback and completion checks

`failure` is null or `{kind, message}`. The allowed kinds are defined by `TestRun` in [host.ts](../ui/src/setup/host.ts). A stopped test has `status: "failed"` and `failure: {kind: "stopped", message: "You stopped the test."}`. While a stop request is pending, a running test may report `stopping: true`. The host returns user-safe messages and never provider error bodies. The UI uses fixed service-failure copy. `stoppedAtStep` is a nullable 1-based demonstrated step number. `confirmation` is nullable final-page text. `screens` contains up to 20 `{image}` records, oldest first, with PNG data URLs. The page labels them only "Final screen" or "Earlier screen": a screen's recorded note can hold the agent's private reasoning, so hosts don't send it and the page ignores a `thought` field from older hosts. The live view is watch-only. Finished image navigation never controls the browser.

`activity` is the run's activity feed: `{revision, browser, snapshot, items}`. `browser` is `starting`, `live`, `closing`, `closed`, `unavailable` or `unknown`; `closing` and `closed` mean the agent closed the browser while the run may still be finishing, and `unknown` means the browser was lost without a confirmed closure. `snapshot` is null or `{image, sequence}` with the latest PNG data URL of the agent's page. `items` holds up to 200 `{sequence, kind, status, text}` entries, oldest first: `kind` is `stage`, `action` or `lifecycle`, `status` is `started`, `executed`, `blocked`, `rejected`, `completed` or `failed`, and `text` is a fixed label written by the web agent. `activity` is null when the host could not read the feed this time and absent when there is none. A higher `revision` replaces the shown feed; a lower one is stale. The setup test and run observer draw the live browser from `snapshot` and finished screens from `screens`. Neither embeds the provider's viewer, so the provider's disconnect page cannot appear; `liveViewUrl` remains for older setup pages and is null once the browser is no longer live.

For new agents, `draft.doneWhen` defaults to `{kind: "file"}`. File checks compile to `[agent, download]`; `{kind: "text", value}` to `[agent, expect_text]` with 1–200 characters and a 10-second timeout; `{kind: "described", value}`, `{kind: "email", address, channelId}` and `{kind: "clicked", value}` to `[agent]`. The host must accept these exact stage lists. A successful run may have no files.

Edited step drafts use `compileEditAgent` in [compiler.ts](../ui/src/setup/compiler.ts) to retain the existing non-agent stages instead of replacing them with the new-agent completion stages. `saveDraft` receives that configuration before `testAgent`; only `publishDraft` promotes the tested draft. Written instructions remain raw stages until a usable demonstration replaces them. See [editing an existing agent](../README.md#edit-an-existing-agent) for the user flow and [host.ts](../ui/src/setup/host.ts) for the edit request shapes.

Described criteria contain 1–300 characters after trimming and reject disclosed credentials, like exact text checks. They are appended to the agent prompt: the agent returns `completed` only when the criterion is visibly met and supplies short, factual on-screen evidence in `confirmation`. If the steps finish without meeting it, the agent returns `failed`, a reason starting exactly `Success criterion not met: `, and `step: null`. The host may classify that failure as `steps`; the UI maps the prefix to `check`, shows the remaining reason, opens Done-when choices, and does not blame a step. Successful described checks show `Agent saw: …` evidence. Existing saved `text` drafts still compile to `expect_text`. No host/CFE contract change is required: `saveAgent` in `ui/src/setup/host.ts` passes the compiled config through.

Hosts advertise `emailRoutes` only when all three email methods are available. The route starts with the creator as its allowed sender. After engine success, the UI polls every five seconds for at most three minutes, including hung requests, using the current test's fixed start timestamp as `since`. Only `routed` passes the email check. Rejected email offers an explicit sender-accept action followed by a new test. Editing invalidates scheduling until another test passes.

The approved capability contract has no separate text-check flag. `chooseSchedule: true` is the bundled modern-host readiness marker for generated exact-text checks. Email readiness alone does not enable them. Described criteria are available regardless of this flag because they need no `expect_text` stage. Older hosts omit both new flags; the UI hides unsupported options and retains the inline daily-time/manual schedule fallback.

The modern host opens its existing `SchedulePresetEditor` for `chooseSchedule`. Cancel returns null and leaves setup on Test. Empty cron finishes setup for manual runs; non-empty cron goes to `scheduleAgent`. No duplicated schedule editor or cron parser lives in this UI.
