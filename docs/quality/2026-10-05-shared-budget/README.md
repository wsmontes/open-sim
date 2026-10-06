# Shared resource budget validation — 2026-10-05

The policy coordinates fixed reservations for map raster/geometry, encoded caches, terrain, mobility, normalization and network peaks. Device memory selects a conservative initial profile; observed render/load pressure reduces detail and healthy trials restore it. These are estimated managed budgets, not total browser/GPU memory measurements.

Full release validation: 156 test files, 1089 passing tests, 5 skipped; typecheck and build passed. An unconstrained repeat timed out one shell boot test at its default 5 seconds; the complete publication configuration (two workers, 20-second timeout) passed again. Existing lint and large-bundle warnings remain. Independent review found no remaining critical or important issues.

Native Chrome exercised neighborhood, region, rotated/night continent, planet, return to neighborhood, repeated rapid zoom cycles and active 3× simulation. No captured console errors or WebGL recovery during these runs. The neighborhood screenshot and DOM statistics are local build evidence. Temporary reprojected imagery and the loading overlay appear during rapid transitions; settled detail returns. These observations do not prove the original crash has been eliminated or guarantee uninterrupted frames.

Planet selection released scene geometry, terrain scene and mobility network to zero. Settled neighborhood retained about 5.1 MB scene geometry, 10.5 MB encoded geography, 0.97 MB mobility input and 13,978 network edges, below the 16,384 edge limit. A real dense Vancouver tile probe retained nonempty networks for 2/4/8 GB profiles (3,746 / 5,615 / 11,849 edges). Probe construction times are worker algorithm measurements, not native UI benchmarks.

Limits: JS object/driver/browser allocations, player state and derived metadata are not exact byte measurements. Unsupported worker hosts use bounded yielded fallback; excessively large normalization fails rather than importing partial world data. Single feature processing is bounded by points but has no universal 4 ms guarantee. Production validation is recorded separately after publication.
