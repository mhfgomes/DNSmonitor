# Editing and deleting monitors

Monitor details provide **Edit monitor** for the name, hostname, record type, mode, expected records, matching policy, resolver addresses/ports/protocols, and timing settings. The existing timing-only editor remains available. Paused monitors stay paused after edits.

## Edit semantics

- Name-only changes preserve the baseline, current answer, counters, incident and check history. Previously queued notifications retain their original payload, including the name at the time of the event.
- Timing-only changes reset confirmation counters and pending WATCH candidates, preserving the accepted baseline and open incident, as in the timing editor.
- Changing the DNS target, record type, mode, expected values, matching policy or resolver configuration starts fresh evaluation. WATCH relearns its baseline; EXPECTED starts new failure/recovery streaks. Current answers are cleared.
- An existing open/acknowledged incident closes with `closure_reason=CONFIGURATION_CHANGED`. This is **not DNS recovery** and sends no recovery notification. The API represents it as RESOLVED with a closure reason; the UI labels it Closed and explains why.
- A configuration-change event records the previous and new revisions. Existing events, incidents and hourly archives remain subject to retention. Old raw checks are retained until normal cleanup but are excluded from the current resolver-results view after a query change, so answers from the old target are never presented as current results.
- Pending jobs and pending/processing/failed deliveries for the old evaluation are cancelled. Sent delivery history remains. An external notification already in flight cannot be recalled.

Hostname normalization, canonical expected record sets, resolver ordering and an omitted/default port of 53 do not cause a reset by themselves. Resolver IDs remain part of the evaluation identity. Each save invalidates in-flight check ownership and schedules a fresh check; stale results cannot commit.

## Concurrency

`GET /api/v1/monitors/:id` now includes `configRevision` and full resolver settings. `PUT /api/v1/monitors/:id` accepts the same monitor input as creation, plus a required integer `revision` matching that value. A stale revision returns HTTP 409 and leaves the monitor unchanged. Edit dialogs retain the original revision even if background polling updates the page.

Validation precedes changes, and all state/configuration/resolver/outbox changes are one database transaction. A failed edit rolls back completely. Resolver groups are replaced privately; other monitors' groups are not modified.

## Deletion

**Delete monitor** opens a dialog requiring the exact monitor name. It permanently removes the monitor, raw checks, hourly summaries, events, incidents, notification jobs and delivery history. Unused resolver groups are removed too. Account audit records and notification channels remain.

Targeted alert rules have this monitor removed from their scope. A rule targeting only this monitor is deleted, avoiding accidental expansion to all monitors (an empty scope otherwise means all). Rules already applying to all monitors remain unchanged. Database transactions coordinate rule creation, notification routing and deletion.

`DELETE /api/v1/monitors/:id` requires `{ "revision": 3, "confirmName": "Example monitor" }`. Wrong names return 400; stale revisions return 409. Mutations require an admin session and CSRF token. Checks completing after deletion cannot recreate state or events, and notifications already in flight remain the only unavoidable delivery race.

Deletion is transactional and can take longer for monitors with large retained histories. If a database lock timeout occurs, the request rolls back and can be retried; partial deletion is never committed. No monitor in the installation is deleted merely by deploying this feature.
