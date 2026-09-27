# Independent label review, 2026-09-27

Reviewed by the separate Perch/protocol investigation worker before any live
predictions. The reviewer inspected the submitted source windows, candidate rule
wording, and public repair/test source. This was not a blind review: the manifest
contained its proposed labels and repair rationales. No model predictions or
scores were available to the reviewer.

Frozen input hashes:

- Fixtures: `62f521eba51b83c71e18a7f60471aeaf9d7c9bfc231bbc373da5b5fe96b884f8`
- Candidate pack: `de0a1e0b83c277611c78fac6ee20001ddd0f6a252f6fa141ee2a8fac81992ea8`
- Submitted manifest: `06b6882631cd67d633ed28ee35d5f99a3d768ee8a0d79740329822dadfabe237`
- Reviewed manifest: `f00c23123ffd0c40c44dee4b74c2c203670f885d70960faec90d6576802c22f8`

The inference family is excluded. The other thirteen units are admitted as
discovery evidence: four violations and nine controls, across three repositories.
Rules were developed from these repairs, so these are not held-out generalization
measurements. Paired units and related controls are correlated.

| Unit | Review decision | Visible evidence |
| --- | --- | --- |
| `ghostget-login-before` | violation, accepted | Explicitly discards the token-save promise, then returns signed-in success. The repair's delayed-write and rejected-write tests establish that persistence is required for the success claim. |
| `ghostget-login-after` | clean, accepted | Awaits save and returns error when it rejects before returning success. |
| `sys1-inference-before` | proposed violation rejected; family excluded | Zero coverage and zero confidence explicitly disclose non-result, and the earlier method documentation describes this as reporting zero confidence rather than guessing. Whether `ok:true` is misleading depends on the contract not present in this excerpt. The repair tightens wire shape; this is not an unambiguous positive under a generic rule that exempts explicit unavailable/partial results. |
| `sys1-inference-after` | clean in isolation; family excluded | Explicit `ok:false` for null outcome. Excluded with its contested paired positive to avoid selecting the convenient half of the family. |
| `sys1-manifest-before` | violation, accepted | Foreign manifest JSON passes a schema that only bounds filename type/length, then that filename is joined under `modelsDir`. The repair test supplies `../../escape.gguf`. |
| `sys1-manifest-after` | clean, accepted | Allowed filename starts alphanumeric, contains only lowercase alphanumerics/dots/hyphens and ends `.gguf`; it cannot contain separators or be `..`. This only establishes component validation, not safety against every symlink or trusted-caller bypass. |
| `design-kit-forced-before` | violation, accepted | Visible `forcedTheme` contract promises a lock, but computation takes valid resolved theme first. |
| `design-kit-forced-after` | clean, accepted | Visible helper picks a valid forced theme before the resolved preference. |
| `design-kit-label-before` | violation, accepted with narrow scope | Synchronous outside-focus blur closes the disclosure containing labels/radios, without an inside-pointer guard. Public mouse/touch regression source establishes interruption when hosted inside a focusable ancestor. That ancestor is not in the excerpt; this relies on the candidate rule's explicitly stated native-event scenario. |
| `design-kit-label-after` | clean, accepted | Inside-pointer state guards blur through native click settlement; outside, Escape, and deliberate Tab paths remain explicit. |
| `sys1-doctor-copy` | clean, accepted | Copy-only changes preserve returned readiness states and awaited probes. |
| `ghostget-views` | clean, accepted | Missing, unauthorized, or ambiguous supplemental views remain unavailable/partial; valid carried data or an explicit fallback are used. No fabricated ordinary count is visible. |
| `design-kit-relative-time` | clean, accepted | Time element has no disclosure dismissal or label/input activation. |
| `ghostget-storage-fallback` | clean, accepted | A failed keychain save is followed by an awaited file save; that file rejection propagates. The empty catch alone is not false success under this rule. Other storage-policy concerns are out of scope. |
| `design-kit-no-override` | clean, accepted only for shown context | No explicit override input or precedence contract appears in the snippet, so the evidence-requiring rule must abstain. This is deliberately not a claim that the containing historical component was correct. |

Independent source checks included these exact public revisions:

```sh
# /Users/bg/src/ghostget
git show 42fbc4d05e5011c5112fee1f4afbb7e81072e1f5 -- src/accounts-auth.test.ts
# /Users/bg/src/sys1
git show 67197a91118e892c0545a0fe25f23705c6bb9be7 -- test/local-store.test.ts
git show 3fa98af5f2ad491fb108d33bc126d7ca31b26e9a -- src/local/runner.ts src/local/decide.ts
# /Users/bg/src/design-kit
git show f335cf879a692b193ace8a64ba55eab7e3a85fe2:src/react/theme-resolution.test.ts
git show 850a0d3e98a5d897ba8951544b0caafc007fd7f3:scripts/palette-browser.ts
```

These commands inspect regression evidence; this label review does not claim it
ran historical application tests or browsers. Source-byte reproduction and
deterministic baselines have their own receipts. Retain low support and
selection bias in every reported accuracy claim, especially for the single
native-activation family, whose rule wording closely describes its known repair.
