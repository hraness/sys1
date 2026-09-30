# Canonical portfolio messaging

Product names, descriptions, marketing heroes, and named section headings are authored in [hraness/jungle](https://github.com/hraness/jungle/blob/main/portfolio-projects.json). Do not copy new prose into the site or edit the generated snapshot by hand.

`portfolio-messaging.generated.json` pins the public portfolio digest and carries this product's messaging plus canonical related-product names, descriptions, URLs, and relationships. Website builds use the checked snapshot offline.

From this repository root, with `PORTFOLIO_SOURCE_CHECKOUT` pointing to a validated Jungle checkout:

```sh
bun "${PORTFOLIO_SOURCE_CHECKOUT}/scripts/sync-product-messaging.ts" \
  --portfolio "${PORTFOLIO_SOURCE_CHECKOUT}/portfolio.public.generated.json" \
  --product sys1 --output portfolio-messaging.generated.json --write
```

Refresh `portfolio-system-one-skills.generated.json` with the same command using `--product system-one-skills --output portfolio-system-one-skills.generated.json`.

Drop `--write` to verify the checked snapshot against that catalog. Commit the snapshot and the generated artifacts after the site checks pass.

`scripts/build-site-copy.ts` renders the authored `site-templates/` into every committed HTML page under `site/`. This preserves the static Vercel deployment. `bun run check:site-copy` rejects stale rendered pages.

Edit authored page content in `site-templates/`, then regenerate. The release synchronizer updates current version references in both templates and served pages. After refreshing generated platform, footer, syntax, or media blocks, update the same authored template blocks before regenerating the pages.

Validate changes with `bun run build:site-copy`; if social copy changes, also run `bun run social:generate`; then run `bun run check`.

Technical documentation, research records, release evidence, and runtime copy retain their existing owners.
