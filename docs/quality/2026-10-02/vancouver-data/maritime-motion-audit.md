# Maritime movement — 2026-10-03

Production engine and canvas vessel commands are connected to the main geographic scene. Passenger ferries, recreational sailing, cargo and active captured cruise calls use verified centre corridors; BC Ferries is excluded from free generation. Rendering uses water elevation 0, terrain visibility, geographic depth ordering, camera culling, 24 vessels near / 8 far. Physical dimensions and speeds are simulation parameters.

Cruise routes are explicitly bound to the published berth. East and north approach corridors were added and all 14 corridors passed the cached 36-tile actual-coastline intersection audit. Their endpoints match derived berth positions. The cruise calendar contains only three October 3–4 calls; its full-day windows are derived, not actual arrival/departure hours.

A 4,000-second fixed-step operation audit observed 12 vessels, all four phases, occupied-berth exclusivity and a stable paused frame. Native preview inspected cargo/cruise scale, SeaBus/Aquabus paint and sail geometry, two ten-minute advances, night, rotation and pause. Preview route lines are diagnostic; actual coast/terrain rendering is provided by the main application. Neither the audit nor the geometry is a navigational certification: no live AIS, tidal water height, collision avoidance between different corridors, or measured ship dimensions. Small ferries use a simulated 10 m / 3 m opposing lane taper; source centreline validation does not validate bathymetry along that offset.

Validation: targeted tests, typecheck, full check (879 passed, 5 skipped before the additional physical-berth regression test), production build. Bundle is 1,001.50 kB raw / 225.15 kB gzip; final source splitting and formal performance comparison remain Task 22.
