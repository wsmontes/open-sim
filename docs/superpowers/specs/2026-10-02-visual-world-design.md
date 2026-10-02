# A legible city, from the street to the planet

User-authorized scope: overhaul the published game's visual quality, preserve real geography, keep buildings legible at city zoom, and extend navigation to the planet. The user explicitly waived approval gates on 2026-10-02.

## Visual direction
SimCity 2000 is the minimum reference for readable silhouettes, varied building massing, consistent light and shadow, clear connected streets, and useful tools. Use original procedural art and real OSM footprints; do not copy game assets. Muted earth and park colours, blue water, warm masonry, cool glass, pavement and sidewalks form the palette. A building is a building footprint, not a separate house on every occupied simulation cell.

References inspected: https://gamesdb.launchbox-app.com/games/details/41076-simcity-2000 ; https://shortbread-tiles.org/schema/1.1/ ; https://www.openstreetmap.org/#map=15/49.2827/-123.1207 ; https://www.naturalearthdata.com/about/terms-of-use/

## Geographic presentation
Retain visual vector geometry alongside the existing simulation grid, without changing economics or overwriting player edits. Decode tiles at zooms 0–14 for the visible geographic area with a bounded request set. Preserve roads, water, land cover and building polygons. Building height is stylized unless the source provides height; Shortbread does not promise actual height. Present inference honestly in source information. Use the same coordinates and camera anchor at every scale. Render roofs and walls in screen depth order; keep footprints visible in the city view rather than replacing them with coarse blocks. Player-built geometry takes priority over imported geometry where edits overlap it.

## World navigation
Extend the camera ladder logarithmically below the old 0.05 limit. Do not enumerate simulation chunks at regional/world scales. Use a geographic tile view at regional scales and an orthographic globe with public-domain Natural Earth continent polygons at planetary scales. Include visible scale/coordinates and direct City/World controls; returning to City restores a usable construction scale at the same geographic focus. Labels identify real places as the camera moves. The globe must show genuine continents, support drag and zoom, and permit a return to the selected place.

## Interface
Keep zoom controls visible on narrow windows. Put all construction tools in an obvious reachable arrangement with scroll affordance on phones; separate simulation speed from the tool strip. Panels respect the top bar and bottom tools. Keep map attribution legible.

## Acceptance
Compare Vancouver, São Paulo and Lisboa against OSM at known coordinates. Inspect near, medium, city, regional and planetary zoom, both directions, and rotation. Verify footprints never multiply into houses, streets preserve bends, coasts stay in position, global requests stay bounded, player construction/demolition remains visible, and legacy saves open. Run typecheck, lint, the complete test suite and production build; then inspect the built game in the browser at desktop and narrow viewport sizes. Deliver source changes and visual screenshots; do not claim exact reproduction of real building heights or a subjective SimCity quality threshold solely from automated tests.
