# Changelog

Each release page on GitHub copies its version's section from this file. Write
the section in the pull request that bumps the version: a one-line summary
paragraph, then one bullet per change a user or operator would notice. Keep
each paragraph and bullet on one line; release pages render line breaks.

## 0.10.0 - 2026-09-21

Sys1 can send decisions to a Kev server you run, and versioned decision profiles let you reuse the same questions and instructions with hosted Jev, a local model, or Kev.

- `sys1 backend add --adapter kev` registers a Kev server. The gateway converts each request and response to and from Kev's format, keeps Kev's two-decimal probabilities without renormalizing them, and marks Kev answers with `x-sys1-adapter: kev` and `x-sys1-probability-decimals: 2`. Kev never receives unpinned traffic; a request reaches it only with a `backend/model` pin.
- `sys1 backend check` tests a Kev backend against Kev's decision format.
- `createProfile` (from `@hraness/sys1` and `@hraness/sys1/client`) builds a frozen, versioned profile with a pinned model and fixed questions. `profile.request(state)` returns an ordinary System One request.
- `sys1 eval --profile FILE` applies a saved profile to JSON input that contains only `{"state": ...}`. `examples/ticket-triage.profile.json` is a starting profile.
- The client accepts `adapter: "kev"` for calling a Kev endpoint directly, and reports Kev's precision in the response metadata.
