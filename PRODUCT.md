# Product

## Register

product

## Users and purpose

Accountants and operations users set up web agents by demonstrating a task in an embedded virtual browser. They review the captured steps, choose reusable inputs, test a fresh run, and schedule only after checking the result.

## Product direction

This public Reiterate fork provides demonstration authoring. The Reiterate host owns authentication, agent storage, computer-use execution, and scheduling. Users do not install an extension. Existing upstream code may be retained selectively; the target engine is computer-use.

## Design

Calm operational UI for daytime desktop work. Use a light surface, dark navy text, one blue action color, readable system sans typography, restrained borders, and clear progress. Prefer an editable sequence of meaningful steps over selectors or a technical node editor. Preserve keyboard navigation and WCAG AA contrast.

## Honest state

Recording is not agent success. Generated instructions are drafts. Test status comes from the host's real run. Changing the workflow or its inputs invalidates previous test acceptance. Scheduling follows a successful unchanged test and explicit user confirmation of its result. Expired sessions and missing integrations are visible, recoverable states.

## Data boundary

Keep credentials out of demonstrations and prompts. Browser and platform credentials stay server-side. The public iframe communicates through a narrow origin-checked host bridge; no Auth0 token is passed to it.
