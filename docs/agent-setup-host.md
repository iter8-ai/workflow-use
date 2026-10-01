# Agent setup host contract

Embed the UI in an iframe with `parentOrigin` set to the host origin. The UI accepts responses only from that exact origin and its parent window. Hosts must accept requests only from their configured UI origin and the iframe window.

Requests use `{type: "workflow-use:request", version: 1, id, method, params}`. Responses echo the id with `{type: "workflow-use:response", version: 1, id, result}` or a user-safe `error` string. Do not send authentication tokens, service keys, or private execution credentials in either direction.

| Method | Parameters | Result |
| --- | --- | --- |
| ready | empty object | `{schedule: boolean, credentials?: boolean, emailRoutes?: boolean, chooseSchedule?: boolean}` |
| startRecording | `url` | Recording |
| getRecording / stopRecording | `id` | Recording |
| cancelRecording | `id` | null |
| requestCredentials | `kinds`, optional `replace` | `{saved: kinds}` |
| saveAgent | `draft`, `config`, optional `agentId` | `{id}` |
| testAgent | `agentId`, `arguments: {}` | `{id}` |
| getTestRun | `agentId`, `runId` | `{status, error?, files?, liveViewUrl?, failure?, stoppedAtStep?, confirmation?, screens?}` |
| createEmailRoute | `name` | `{channelId, address}` |
| getEmailArrival | `channelId`, `since` (test-start ISO timestamp) | `{status: "waiting" \| "routed" \| "rejected" \| "no_documents", from?, files?}` |
| allowEmailSender | `channelId`, `sender` | null |
| chooseSchedule | `cron` | `{cron}` or null on cancel |
| scheduleAgent | `agentId`, `runId`, `arguments: {}`, `cron` | null |
| close | optional `agentId` | null |

The TypeScript shapes are in [host.ts](../ui/src/setup/host.ts). Recording statuses are recording, stopped, and expired. Test statuses are running, succeeded, and failed. Cron expressions have five fields and use UTC.

Start URLs must omit query parameters, fragments, and embedded credentials. The host binds saved configurations to the successfully recorded starting URL and requires a stopped, unblocked recording. The host owns access control and validates every request independently. It must bind recording operations to the authenticated tenant and user, bind agent operations to the current setup, and reject scheduling unless the latest saved version passed a test. Duplicate request ids should reuse the same response. Closing setup must close any active recording. The host may open the saved agent after closing, but must select it from its own setup state rather than trust the optional agentId in the close request. Closing alone does not attest that a test passed or that the user reviewed its result.

Treat all draft text and recorded page content as untrusted. The compiler emits semantic computer-use stages, not DOM selectors or a browser-use execution loop. Demonstrated form entry is repeated with the exact recorded values; reusable per-run inputs are not supported. Test and schedule requests must carry an exact empty `arguments` object.

## Sign-in details

Recording steps never contain sign-in values; a `credential` step records only the kind (`username`, `password`, or `otp`). The recording service's `POST /recordings/{id}/stop` response additionally carries `credentials: {username?, password?}`, the values typed into the demonstrated sign-in form, exactly once and with `Cache-Control: no-store`. This is a service-to-host field: the host must keep it, save it as the agent's encrypted parameters, and strip it before answering the iframe's `stopRecording`, whose Recording result has no credentials. Discarding the recording (`cancelRecording`) must discard the values captured by it.

`requestCredentials` asks the host to make sure the listed kinds are saved. The host asks the user in its own UI only for kinds it does not hold (typically the authenticator key for a one-time code), or for all listed kinds when `replace` is true, and answers with the kinds that are saved, never the values. Hosts that return `credentials: false` (or omit it) from `ready` cannot store sign-in details, and the UI will not test an agent that needs them.

## Test feedback and completion checks

`failure` is null or `{kind, message}`. Kinds are `service`, `signin`, `website`, `steps`, `result`, and `check`. The host returns user-safe messages and never provider error bodies. The UI uses fixed service-failure copy. `stoppedAtStep` is a nullable 1-based demonstrated step number. `confirmation` is nullable final-page text. `screens` contains up to 20 `{image, thought}` records, oldest first, with PNG data URLs. The live view is watch-only. Finished image navigation never controls the browser.

`draft.doneWhen` defaults to `{kind: "file"}`. File checks compile to `[agent, download]`; `{kind: "text", value}` to `[agent, expect_text]` with 1–200 characters and a 10-second timeout; `{kind: "email", address, channelId}` and `{kind: "clicked", value}` to `[agent]`. The host must accept these exact stage lists. A successful run may have no files.

Hosts advertise `emailRoutes` only when all three email methods are available. The route starts with the creator as its allowed sender. After engine success, the UI polls every five seconds for at most three minutes, including hung requests, using the current test's fixed start timestamp as `since`. Only `routed` passes the email check. Rejected email offers an explicit sender-accept action followed by a new test. Editing invalidates scheduling until another test passes.

The approved capability contract has no separate text-check flag. `chooseSchedule: true` is the bundled modern-host readiness marker for generated and custom text checks. Email readiness alone does not enable them. Older hosts omit both new flags; the UI hides unsupported options and retains the inline daily-time/manual schedule fallback.

The modern host opens its existing `SchedulePresetEditor` for `chooseSchedule`. Cancel returns null and leaves setup on Test. Empty cron finishes setup for manual runs; non-empty cron goes to `scheduleAgent`. No duplicated schedule editor or cron parser lives in this UI.
