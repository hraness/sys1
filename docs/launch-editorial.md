# Introducing Sys1: editorial record

## Admission before drafting

- **Route:** `https://sys1.io/introducing-sys1`
- **Title:** Introducing Sys1
- **Reader job:** Decide whether small model decisions can help a coding agent review a change and check the claims in its completion message, then choose a first experiment.
- **Non-obvious answer:** The reusable part is the sequence from chosen evidence to a constrained question and an investigated result. A response with the right shape is useful to integrate, but only task-specific measurements establish whether that decision helps. The September 28 screening gives a concrete counterexample: Jev ties simple signature matching on failure triage while its claim-support result warrants a stronger comparison.
- **Canonical host and why:** Sys1's own site publishes the runtime, project skills, and original workflow observations. It can explain what the product implements and connect the release to inspectable evidence.
- **Original contribution:** A review-to-evidence architecture explanation tied to shipped source, plus a readable comparison of all 48 submitted workflow examples and their simple baselines. The chart preserves failed submissions and changes the adoption decision for each proposed workflow.
- **Nearest URLs and overlap:** `/` helps a developer choose Sys1 and find installation; `/skills` is the installation and workflow chooser; `/compare` evaluates model routes using external JevBench evidence. The source trial report records the experiment in detail.
- **Why this should not merge:** This dated launch explanation connects the motivation, implementation, and measured limits in one sustained argument. The homepage should keep its short adoption path, the skills page its setup instructions, and the trial report its complete observations. This is the one launch post, not a series of keyword variants.
- **Primary evidence and checked date:** September 28, 2026. `src/protocol.ts`, `src/backends.ts`, `src/router.ts`, `src/review/`, `src/verify/`, `docs/design.md`, `docs/review.md`, `docs/verify.md`, `docs/profile-evaluation.md`, the v0.17.0 release record, and `benchmarks/workflows/results/2026-09-28.md` with its summary JSON. Source revision before this launch change: `3cfc8261bd533467f58ae40ebba70353fe8e2afe`.
- **Claim-risk review:** Independent Codex AI agent `/root` source/editorial review passed on September 28, 2026. No human or specialist review claimed. Claims concern developer software, not regulated advice.
- **Human voice evidence:** None. Hraness is the publication byline; the article is agent-drafted analysis and contains no personal first-person claims.
- **Homepage slot:** One text link to the launch explanation near the product introduction, selected for its distinct reader job rather than recency.
- **Owner:** Sys1 maintainers.
- **Evidence owner:** Sys1 repository and retained workflow reports; TypeSafe owns its model documentation.
- **Lifecycle state:** Independent source and editorial review passed; publication waits for rendered checks.
- **Reassess on:** November 9, 2026, or a change to the installed workflows or model routing that invalidates the explanation, whichever comes first.

| Dimension | Score | Reason |
| --- | ---: | --- |
| Reader utility | 2 | Enables a concrete choice between a project skill, source-only experiment, and deterministic code. |
| Original evidence | 2 | Uses the product's shipped behavior and its owned, frozen 48-case trial. |
| Factual confidence | 2 | Primary source backs commands, response shapes, observations, and limits. |
| Host fit | 2 | The host maintains the product and experiment. |
| Voice integrity | 1 | Disclosed agent-authored synthesis; no supplied human experience. |
| Maintenance value | 2 | One dated explanation with an explicit owner and reassessment date. |
| **Total** | **11/12** | **Admit one page.** |

The dated article identifies v0.17.0 as the release at publication and links the current installation guide. Future release syncing intentionally preserves this historical version.

## Draft and review record

- Drafter: Codex AI agent `/root/launch_editorial`.
- Draft date: September 28, 2026.
- Style sources: repository `STYLE.md` and `WRITING.md`; [`hraness-generation-style/v1` and its essay addendum](https://github.com/hraness/.github/blob/main/GENERATION_STYLE.md), read from a local synced copy.
- Independent reviewer identity: Codex AI agent `/root`.
- Independent review type: AI source and editorial review.
- Review date: September 28, 2026.
- Human reviewer: none.
- Visible note: “Drafted with AI from the source code and reviewed by Codex.” The HTML and structured credit were updated from this record after independent review.
- Structured disclosure: `BlogPosting.creditText`, `contributor`, and the visible note identify AI drafting and the recorded review without assigning sole human authorship.

## Figure and chart decisions

The architecture figure follows an agent's chosen Git evidence and repository rule through a preview, a selected model, and candidate investigation. Completion verification is a separate row that compares a drafted message with Git, pull requests, and pages. Neither arrow implies automatic repairs, permission to act, or a correctness guarantee.

The trial chart gives each workflow 16 submitted examples. Jev has 16, 13, and 16 label matches; evidence relevance also has three errors. Baseline matches are 16, six, and six. Baseline misses and model errors use different shapes and labels. The chart does not use probability outputs as accuracy, hide errors from the denominator, imply real-repository coverage, or transfer its findings to the installed review skill. The literal-match claim baseline is identified as weak.

The optional 52-second film is user-started, has captions and a prose transcript, and loads no video body until playback is requested. Its poster and captions are provided by the film owner. The article remains complete without playback or JavaScript.

## Validation and release review

- Independent root review approved claims, baseline comparison and error denominators, workflow distinctions, prose, commands, and disclosed authorship. No factual blocker. Removed the public absolute sibling-checkout path from this record.
- Article source inspection verified preview commands, official Jev definitions and source links, and every chart total against `2026-09-28-summary.json`. A static HTML inspection passed all existing local paths and anchors, unique IDs, 143-character matching social descriptions, and valid BlogPosting JSON. The film, poster, captions, and transcript are complete. Their exact identities and independent source and temporal reviews are recorded in `media/sys1-launch/receipts/`.
- One Impeccable detector pass completed. The video-padding warning concerns intrinsic media content; the footer-padding warning is on the unchanged pinned shared footer. Type and radius advisories refer to the historical `DESIGN.md`, while the page follows the current site's implemented typography and tokens. No new functional issue was reported.
- The integration owner runs the final repository check and browser verification before delivery. The browser suite covers five widths in both themes, keyboard controls, reading without JavaScript, reduced motion, requested-only video loading, and playback. The pull request and production-verification artifacts record the final results.

## Launch beats addendum (September 29, 2026)

- **Change:** A generated "The short version" section follows the film: nine standalone beats, each one headline, one short paragraph and one visual (seven code-built illustrations, one film still, one scorecard). The social kit (X, Bluesky, Threads, LinkedIn, Product Hunt and the Show HN fact sheet) is cut from the same beats in `kb/launch/social-kit.md`. The long-form essay below is unchanged.
- **Sources:** every number comes from `scripts/launch/facts.ts`, which names its source file; `test/launch-facts.test.ts` pins each value to that file. The status is `Latest release: v<package version>` and follows `scripts/sync-public-release.ts`.
- **Illustrations:** built from `@hraness/design-kit/mockups` (neutral agent, terminal and browser chrome), labelled "Illustration" in captions and accessible descriptions, with made-up repositories and accounts (`orders-api`, `jmoreno`, `code.example`). No vendor chrome or marks.
- **Limits beat:** reports the proof roadmap's whole-task results without softening: the review skill was never called when optional, and directed use cost more tokens and time with 22 of 32 correct against 29 of 32.
- **Film:** the existing 52-second film is kept. A 1:1 cut (`site/media/sys1-launch-square.mp4`) was rendered from `media/sys1-launch/cuts.json` for feeds. No native portrait film: the slides are landscape compositions, and a letterboxed 9:16 would not read on a phone.
- **Admission:** unchanged at 11/12; the page stays indexed. The addendum adds a scannable summary of claims the admitted article already makes, plus the scorecard from the dated roadmap.
- **Review:** AI-drafted by a Claude Code agent from source; independent agent review happens on the pull request. No human review is claimed.
