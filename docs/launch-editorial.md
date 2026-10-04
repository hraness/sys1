# Introducing Sys1: editorial record

## Product guide revision (September 30, 2026)

- **Decision:** Revise the existing article. Keep its URL and useful workflow examples; remove the repeated social posts and the source-profile research narrative from the reading path.
- **Reader job:** Choose a first useful check, understand the result it returns, and install the appropriate skill for a coding agent.
- **Non-obvious answer:** Compact check output is a separate, model-free skill. Sys1 adds optional model-assisted review and completion checks. A useful installation starts with the check the repository needs and an explicit instruction to the agent.
- **Canonical host and original contribution:** Sys1 maintains the installed commands, project instructions, and review workflow. The article connects those commands to an example change and shows how to investigate a finding and verify a proposed completion message.
- **Nearest URLs:** The homepage introduces the product; `/skills` owns installation and detailed skill usage; `/docs` owns command and API reference. This article supplies a sustained worked explanation across those choices, rather than another command reference.
- **Primary evidence checked:** September 30, 2026. `docs/review.md`, `docs/verify.md`, `src/review/cli.ts`, `src/verify/cli.ts`, the current release record, the compact-output replay, `docs/proof-roadmap-2026-09.md`, and the completed 60-run completion baseline linked there.
- **Claim review:** Whole-task token and time savings have not been demonstrated. Review and completion checks remain experimental and advisory. Local Qwen remains experimental; Jev is opt-in. The completed baseline does not justify automatic intervention.
- **Voice:** Agent-drafted product explanation; no personal experience or human review claimed. Drafter: Codex AI agent `/root/launch_finish`. Independent source/editorial review and rendered verification are owned by the integration agent before release.
- **Film:** Retain the existing film. Its transcript accurately labels advisory findings, opt-in hosted calls, experimental local models, and source-checkout profiles. Move it after the practical guide; it is optional and makes no whole-task savings claim.
- **Owner:** Sys1 maintainers. **Lifecycle:** Revision in review. **Reassess:** November 9, 2026, or a change to the commands, routing, or study conclusions.

| Dimension | Score | Reason |
| --- | ---: | --- |
| Reader utility | 2 | A visitor can choose and install a skill for a specific repository task. |
| Original evidence | 2 | The examples follow shipped command behavior and the owned studies. |
| Factual confidence | 2 | Commands and claims are checked against source, with the model limits alongside them. |
| Host fit | 2 | Sys1 owns the runtime and project skills. |
| Voice integrity | 1 | Disclosed AI synthesis, without supplied human experience. |
| Maintenance value | 2 | One maintained article links to detailed guides and preserved study reports. |
| **Total** | **11/12** | **Revise the existing page.** |

## Homepage, skills, and documentation review (September 30, 2026)

Reviewer: Codex AI agent `/root/launch_finish`. Review type: independent
source, editorial, and representative rendered review of the integration
owner's homepage, skills, and documentation revisions. No human review is
claimed. The reviewer supplied narrow preview-copy, illustration, and Jev
definition corrections; the integration owner reviews those repairs as part
of final delivery. Sys1 maintainers own these pages and their evidence.
Reassess on November 10, 2026, or a release that changes the documented
commands, installation requirements, or model behavior.

### Homepage: `/`

1. The reader can decide whether compact check output fits their agent's work
   and choose installation or an optional review workflow.
2. The page shows the command, returned result, and saved log together. It
   supplies the short adoption decision that the command reference and study
   reports do not, while `/skills` supplies the installation procedure.
3. Sys1 is the right host because it maintains the optional workflows and can
   explain their relationship to the separate System One Skills package.
4. Installation requirements and release links would become stale first.
   The replay figure remains a dated byte measurement, with no whole-task
   token, cost, or time claim inferred from it.
5. No first-person endorsement or personal experience is asserted. The
   authored agent conversation and terminal examples are labelled illustrations.

Keep the homepage URL: it offers a concise product choice before setup.

### Skills: `/skills`

1. The reader can install the compact-output package and project skill, run a
   first check, find the saved log, and add optional review or completion checks.
2. This page connects package installation, agent-specific skill directories,
   first execution, and interpretation of the result. The homepage introduces
   those choices; the runtime reference covers a broader set of commands.
3. Sys1 maintains the project skills and links directly to the independent
   compact-output package's released artifact and command reference.
4. Release URLs, minimum runtimes, setup targets, and preview behavior are the
   first claims to recheck when either package changes. Source review corrected
   the verification preview description: it reports input type and model route,
   not the message contents or collected evidence.
5. No first-person sentence claims personal use or an unsupplied endorsement.

Keep the skills URL: it owns the installation and first-run procedure for the
three supported coding-agent environments.

### Documentation: `/docs`

1. The reader can install Sys1, configure a model, preview an agent workflow,
   make an API request, and select a supported integration mode.
2. The page joins setup, expected results, failure interpretation, and detailed
   references in one navigable guide. The skills page remains focused on agent
   installation; the launch article explains a worked use case.
3. Sys1 owns the CLI, routing, configuration, and response validation described
   here. Linked model documentation remains the provider's authority.
4. CLI flags, activation settings, supported model IDs, and platform requirements
   would fail first as the runtime changes. Review checked the setup and preview
   instructions against the shipped CLI and retained the model and evidence limits.
5. The page makes no first-person experience or human-review claim.

Keep the documentation URL: it owns operational setup and application use.

### Rendered evidence and decision

The reviewer inspected the September 30 captures from the integration owner's
browser suite: `1440-light-index.html.png`, `390-light-index.html.png`,
`390-dark-skills.html.png`, and `1440-light-docs.html.png`, with readable crops
of the headers, installation blocks, review instructions, and verification
instructions. Additional `1440-light-introducing-sys1.html.png` and
`390-dark-introducing-sys1.html.png` captures cover the revised article's
opening and workflow presentation. The shared navigation, action hierarchy,
code presentation, light/dark colors, and mobile wrapping show no material
polish issue. Article source review is separately owned by the integration
agent because this reviewer authored that revision.

The inspected suite began with the `2026-09-30T04:54:25.943Z` capture. After
the first-mention Jev correction, the integration owner reran all 80
route/width/theme combinations, interactions, no-JavaScript reading, and
reduced-motion checks. The final `/tmp/sys1-site-browser/results.json` records
`2026-09-30T04:59:00.703Z`, Chrome for Testing `145.0.7632.6`, pinned Playwright
`1.58.2`, and browser/server cleanup. This is local verification; production
verification belongs to the delivery record.

Decision: **no remaining source, editorial, or observed visual blocker** for
these revisions. Compact output has a complete installation path; model
features retain their advisory status beside their instructions. The whole-task
savings limitation and completed baseline conclusion remain accessible without
dominating the installation path.

The earlier records below describe the publication history. This revision replaces their launch-thread and prospective-experiment reading path.

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
- **Human voice evidence:** None. Sys1 is the publication byline (changed from Hraness on 2026-10-04: launch content names the product only); the article is agent-drafted analysis and contains no personal first-person claims.
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

The optional 34-second film is user-started, has captions and a prose transcript, and loads no video body until playback is requested. Its poster and captions are provided by the film owner. The article remains complete without playback or JavaScript.

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
- **Film:** replaced on 2026-10-04 by the 34-second story film in `media/story` (dark palette, foil header mark, ask-your-agent end card), with its 1:1 cut (`site/media/sys1-launch-square.mp4`) from the same engine. The earlier 52-second film's sources stay in `media/sys1-launch` for its record.
- **Admission:** unchanged at 11/12; the page stays indexed. The addendum adds a scannable summary of claims the admitted article already makes, plus the scorecard from the dated roadmap.
- **Review:** AI-drafted by a Claude Code agent from source; independent agent review happens on the pull request. No human review is claimed.


## Product readiness revision (September 30, 2026)

This revision replaces the nine-beat catalogue and repeated reference material with three illustrated workflows, a worked review example, setup, the decision API, and one evidence-and-limits section. The synthetic screening chart remains in its dated report; it is no longer the article’s central proof. The social kit remains repository material. Existing film, captions, transcript, and legacy section anchors are preserved.

Drafted by Codex AI agent `/root/launch_finish`; independently reviewed by Codex AI agent `/root`. No human review is claimed. Root checked the commands and workflow against source, the compact-output figures against the published replay, the whole-task limits against the reports, and the completion baseline’s actual scope. The revised prose makes no claim of proven whole-task savings or review accuracy. Preview instructions match the command’s displayed input type and model route.

Root inspected the rendered desktop launch page, mobile homepage, skills page, documentation, and share image. The final local browser sweep passed 80 route/width/theme combinations, plus interactions, no-JavaScript reading, reduced motion, and video playback. The browser was Playwright 1.58.2’s Chromium 145.0.7632.6, with verified cleanup. Aggregate validation passed 584 tests and the packed CLI check; native installation passed on macOS arm64. Publication and exact production verification remain the integration owner’s next delivery steps.

## Evergreen editorial cleanup (October 1, 2026)

The article header keeps its byline and current installation links, removes visible publication dates and the old release badge, and names Codex AI reviewers in its disclosure. Publication metadata remains accurate; the revision date is October 1. The skills page keeps one command-reference link. The update guide describes the shipped updater in the present tense while retaining the 0.19.0 minimum. The runtime guide accurately labels disabling Jev and links to the workflow and update commands.

Drafted by Codex AI agent `/root`; independently reviewed by Codex AI agent `/root/ghostget_editorial` on October 1, 2026. The reviewer read both complete page bodies and the updater guide, and checked the updater minimum against the changelog, release version, entry point, and installation-lock behavior. No new study, model-quality, human, or professional review is claimed. The existing article admission remains 11/12; reassess on November 9, 2026, or a relevant behavior change. Final aggregate and browser verification are recorded with the pull request.
