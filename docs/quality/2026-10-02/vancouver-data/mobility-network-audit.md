# Mobility network provenance and topology

The network consumes the existing decoded OpenStreetMap geometry; it does not fetch during animation. Street coordinates are source geometry, while inferred topology, nominal grade levels and movement permissions remain marked `derived` whenever grade or direction metadata is unavailable.

The [official Shortbread 1.0 schema](https://shortbread-tiles.org/schema/1.0/) was checked on 2026-10-03. It exposes `oneway` and `oneway_reverse` at zoom 14; lower zooms do not supply an equivalent complete direction network. Its two-way default is used only at zoom 14. Numeric grade levels and source IDs are retained if supplied, without inventing an OSM identity when the tile omits it. Bridges and tunnels infer levels +1 and -1 when explicit levels are absent; ordinary streets infer level 0.

Intersections are split only within the same level. A bridge/tunnel endpoint can meet a surface approach only at an identical snapped endpoint shared by both source paths; this transition is derived. Mere geometric crossing or nearby geometry does not connect grade-separated roads. Endpoints snap to 0.001 world cells for stable IDs. Overlapping tile buffers are split and duplicate directed edges deduplicated by geometry, level and road class. Physical edge length follows local Mercator scale and handles a dateline seam as a short segment.

Motorways/trunks and simulated highways exclude walkers; footways and paths exclude motor traffic. Runways, taxiways and rail lines are outside the ground road network. Pedestrian use of ordinary streets is inferred, pending sidewalk details. Lower zoom geometry is generalized and must not be described as full street-level observed traffic. Actual flow and signal phases are separate inputs in subsequent tasks.

Provider and browser stream already forward complete GeographicTile objects without projection or attribute reconstruction; retaining attributes in the adapter decoder therefore requires no duplicate transformation in those layers. Tunnels stay available to routing but retain the previous exclusion from frozen surface-road cell normalization and from visible surface-street drawing.
