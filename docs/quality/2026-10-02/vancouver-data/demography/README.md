# Real and simulated population correction

The top HUD read `stats.population`, so the saved Vancouver neighbourhood displayed 380 as the city population. It now reads municipal facts and shows the census year. The economy panel explicitly labels the simulated count. The text surface uses the same population formatter.

Vancouver municipality: 662,248, census 2021, bundled Wikidata Q24639; corroborated by https://vancouver.ca/news-calendar/our-city.aspx. This is not a 2026 estimate or Metro Vancouver population.

Coordinate travel clears the previous census. Successful lookups carry their requested geographic position so cities outside the bundled list remain visible near that position. Camera proximity is a display safeguard, not a municipal boundary dataset.

Validation:
- Regression tests first reproduced the wrong HUD count and stale census after coordinate travel.
- 83 test files: 697 passed, 5 skipped with `npx vitest run --maxWorkers=2`.
- Typecheck and lint passed (9 existing unused-variable warnings); production build passed.
- Default fully parallel suite passed all assertions but reported an unrelated unhandled timeout in bounded-db.test.ts; bounded concurrency completed without errors.
- Native browser verification of production preview: Vancouver header 662.248 · 2021; economy residents 380 in the existing saved state.
- Review: geographic lookup regression fixed; no further findings.

Screenshots: `vancouver-header.png`, `vancouver-populations.png`.

This change was verified locally; it was not deployed.
