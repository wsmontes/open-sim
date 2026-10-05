# TransLink route capture

Official source: https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-data
Official archive: https://gtfs-static.translink.ca/gtfs/google_transit.zip
Capture date: 2026-10-03. Feed revision 26SEP_20261002, declared validity 2026-09-07 through 2027-01-03, America/Vancouver timezone. Retrieval is separate from schedule validity. Terms require attribution and permit conditional redistribution; no CC0/Open Government licence is claimed. The mandatory legend is preserved with the capture and must accompany the route UI. Browser CORS is unavailable for the official ZIP, so a selected capture is bundled instead of introducing a backend.

The original ZIP is about 15.3 MiB. Its stop_times.txt expands to 91,753,685 bytes, exceeding the importer's 16 MiB per-entry limit. The bounded offline extractor permits at most 128 MiB declared expansion / 64 entries, streams CSV rows, selects bus/ferry trips touching [-123.27,49.20,-123.02,49.31], and retains one representative per route/shape/direction/service/stop sequence. This is a capture box, not an administrative municipal boundary. The complete selected shapes and stop sequences are retained; only surrounding whitespace on official time fields is trimmed. Original archive SHA-256, original file sizes and transformation are recorded in the artifact. No browser importer budget is increased.

The selected ZIP expands to 6,269,717 bytes, largest entry 3,678,956 bytes (shapes). It contains 73 routes, 408 shapes, 3,233 stops and 995 representative trips. Calendars and declared times remain available; this is not a complete timetable and is not realtime. Bus matching ignores ferry routes, retained for the later SeaBus task. Normalized content remains intact, including protocol entities, and an independent hash test verifies it against its provenance content address. Protocol object envelopes can be reproduced locally.

Reproduce from the downloaded official ZIP:

```
python3 tools/vancouver-transit.py original.zip selected.zip extraction.json
node --import tsx tools/vancouver-transit.ts selected.zip extraction.json
```

Street matching is derived, not an official TransLink street graph. It retains direction and exact stop-sequence variants, restricts available bus edges to a 75 m corridor around the reported shape, and considers up to eight nearby mapped node anchors per stop. Dynamic matching selects a connected sequence instead of choosing an isolated endpoint simply because it is closest. Distances are to derived network anchors (up to 75 m from the reported stop); raw stop locations and reported shapes remain separately available. Missing stops, shapes, network coverage or a connected route emit a report and no bus pattern. No straight connecting line is invented. Without a shape only a connected street-network fallback is allowed, explicitly derived.

Native source-geometry inspection of line 019 used full variants 321367 (direction 0, 55 stops) and 321378 (direction 1, 48 stops); endpoints and source sequence appear in translink-19-geometry.html/json/png. Both curves and their differing terminal loops were checked. Independent comparison to 48 actual z14 OpenStreetMap Shortbread tiles (175,325 nodes, 417,552 directed edges) yielded three connected variants: 023 shape 321415 direction 1 (15 stops, 5,186 m), 019 shape 321368 direction 0 (9 stops, 2,770 m), 019 shape 321372 direction 1 (12 stops, 3,667 m). Thirteen other variants, including the full 019 routes, are rejected with missing-connectivity/coverage reports. This is a concrete integration limitation to retain in later mobility UI; source capture success does not imply every route is drawable in the current street network.

Source geometry and matching tests cover sorted shape sequences, missing references, opposite directions, distinct stop variants, identical pattern deduplication, repeated stop positions, connected fallback, disconnected rejection and an isolated nearest-node regression. Motion, dwell, fleet lifecycle and browser integration belong to Task 14.
