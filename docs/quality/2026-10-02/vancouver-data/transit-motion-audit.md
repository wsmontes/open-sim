# Simulated transit motion verification

Bus identity, positions, frequency and 15-second dwell are simulated. Geometry and declared stops originate from the dated TransLink capture; street paths are derived from the connected OSM network. Two stable buses per pattern share the vehicle queues and intersection reservations.

The native verification page `transit-motion-preview.html` uses the production engine, route generator and drawing helper with three connected captured variants (019 in both directions and 023 in one direction). It verifies curves, stops, pause and 3× acceleration. `transit-motion-paused.png` records a paused frame; two subsequent position reads were unchanged. This page is a verification artifact. Main-city transit integration remains Task 22. Full 019 routes remain rejected where street connectivity is insufficient, as recorded in translink-audit.md.

A finished route disappears before restart at its origin and waits for entry clearance. A dwelling bus retains its intersection reservation until its rear clears. Regression tests exposed and fixed an infinite restart-map iteration when entry remained occupied: restarts now iterate a snapshot and retain retired identity until successful re-entry. Missing network edges withdraw the route.

Verification: 29 targeted tests passed; full check 841 passed, 5 skipped; production build passed. The build retains its existing bundle-size warning. Whole-scene performance acceptance remains Task 22.
