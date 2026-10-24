# Studio billing

Language gate → estimate → worker_prepare → full ASR → arrangement → completion.
A language mismatch never calls worker_prepare and never deducts minutes. Other
failures also do not deduct minutes. The existing successful-completion
transaction remains the only place that deducts minutes.

Processing estimates VAD speech duration plus chosen inter-line gaps, including a
bed tail only in extend mode. Completion bills the smaller of that estimate and
the actual arrangement duration, rounded up to minutes. Missing-line silence can
make the final arrangement longer; that does not increase the original estimate.
Unplaced material can make the estimate larger; reducing it prevents overcharging.

The first successful export per parent Studio job is included. Re-exports bill
ceil(arrangement seconds/60). Export preflight locks the parent arrangement and
checks processing/done export reservations, so two simultaneous exports cannot
both obtain the included render. A failed render charges zero. The UI explains
re-export cost before confirmation; worker_prepare rechecks actual eligibility.

The quote is rechecked under the same parent lock when queuing. A stale quote
returns 409 so the user can confirm the new cost. The first successful completion
gets the included export even if an earlier reservation failed; a competing
zero-cost quote cannot later be charged silently.

Exports capture an immutable arrangement snapshot at queue time. Edits made
later do not alter a queued render. The original unique upload-path constraint is
unchanged; export rows use unique owner/parent/export-job.json marker paths.
