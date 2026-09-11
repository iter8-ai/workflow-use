# Agent setup host contract

Embed the UI in an iframe with `parentOrigin` set to the host origin. The UI accepts responses only from that exact origin and its parent window. Hosts must accept requests only from their configured UI origin and the iframe window.

Requests use `{type: "workflow-use:request", version: 1, id, method, params}`. Responses echo the id with `{type: "workflow-use:response", version: 1, id, result}` or a user-safe `error` string. Do not send authentication tokens, service keys, or private execution credentials in either direction.

| Method | Parameters | Result |
| --- | --- | --- |
| ready | empty object | `{schedule: boolean}` |
| startRecording | `url` | Recording |
| getRecording / stopRecording | `id` | Recording |
| cancelRecording | `id` | null |
| saveAgent | `draft`, `config`, optional `agentId` | `{id}` |
| testAgent | `agentId`, `arguments` | `{id}` |
| getTestRun | `agentId`, `runId` | `{status, error?, files?}` |
| scheduleAgent | `agentId`, `runId`, `arguments`, `cron` | null |
| close | optional `agentId` | null |

The TypeScript shapes are in [host.ts](../ui/src/setup/host.ts). Recording statuses are recording, stopped, and expired. Test statuses are running, succeeded, and failed. Cron expressions have five fields and use UTC.

Start URLs must omit query parameters, fragments, and embedded credentials. The host binds saved configurations to the successfully recorded starting URL and requires a stopped, unblocked recording. The host owns access control and validates every request independently. It must bind recording operations to the authenticated tenant and user, bind agent operations to the current setup, and reject scheduling unless the latest saved version and exact input values passed a test. Duplicate request ids should reuse the same response. Closing setup must close any active recording.

Treat all draft text and recorded page content as untrusted. The compiler emits semantic computer-use stages, not DOM selectors or a browser-use execution loop. Input placeholders are ordinary `{name}` references. Credential parameters are not supported by this release.
