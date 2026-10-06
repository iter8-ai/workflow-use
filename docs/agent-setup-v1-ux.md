# Agent setup, first version

The first version follows a short journey: describe the task, demonstrate it in a browser, review the captured instructions, then test and check the result.

The host application owns the agent list, authentication, saved-agent settings, schedules, and run history. The public authoring UI owns the demonstration and review flow. Execution remains computer-use based. Recording does not add a second execution engine.

## Selected design concepts

- A prominent new-agent action and an actionable empty state lead into setup.
- Name, starting website, and task objective are the first step. A concrete example helps users describe the expected result.
- A large browser sits beside the captured steps. Progress navigation stays compact so it does not consume browser width.
- Finishing the demonstration leads to editable instructions, then a test. Finishing a recording does not imply that the agent works.
- After a successful test, the user checks the result before finishing setup. Manual runs are the default. A daily schedule is optional and repeats the tested workflow.
- Closing setup opens the saved agent when one exists. The host chooses the agent from its own setup state.
- Leaving unfinished setup requires confirmation. The copy distinguishes discarded demonstration work from an agent already saved by a test.

## Deferred

Open-ended training chat, a formula editor, advanced output naming, and additional scheduling controls are not part of the authoring flow. Existing host settings remain available after setup.

For demonstrated sign-in, follow the [README setup and sign-in guidance](../README.md). For sign-in handling and the rules for keeping credential values out of the setup page and recorded steps, see [Sign-in details in the host contract](agent-setup-host.md#sign-in-details).

## Acceptance checks

1. An empty agent list offers setup only when the authoring service is configured.
2. The browser and captured steps remain usable together at desktop widths.
3. Recording, opening, expiry, and failure are distinguishable.
4. A failed or outdated test cannot enable completion or scheduling.
5. A successful, reviewed test can finish with no schedule.
6. Canceling an exit confirmation keeps the current demonstration.
7. Completion opens the host-owned saved agent even if the list refresh finishes later.
8. No source-code or license footer or links in the setup UI. The repository is public and its README carries the AGPL notice; that is enough.

Controlled browser fixtures verify authoring interactions and layout. Authenticated host-to-backend testing is a separate release check.
