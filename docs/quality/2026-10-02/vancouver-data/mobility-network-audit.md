# Mobility network provenance and topology

The network consumes the existing decoded OpenStreetMap geometry; it does not fetch during animation. Street coordinates are source geometry, while inferred topology, nominal grade levels and movement permissions remain marked `derived` whenever grade or direction metadata is unavailable.

The [official Shortbread 1.0 schema](https://shortbread-tiles.org/schema/1.0/) was checked on 2026-10-03. It exposes `oneway` and `oneway_reverse` at zoom 14; lower zooms do not supply an equivalent complete direction network. Its two-way default is used only at zoom 14. Numeric grade levels and source IDs are retained if supplied, without inventing an OSM identity when the tile omits it. Bridges and tunnels infer levels +1 and -1 when explicit levels are absent; ordinary streets infer level 0.

Intersections are split only within the same level. A bridge/tunnel endpoint can meet a surface approach only at an identical snapped endpoint shared by both source paths; this transition is derived. Mere geometric crossing or nearby geometry does not connect grade-separated roads. Endpoints snap to 0.001 world cells for stable IDs. Overlapping tile buffers are split and duplicate directed edges deduplicated by geometry, level and road class. Physical edge length follows local Mercator scale and handles a dateline seam as a short segment.

Motorways/trunks and simulated highways exclude walkers; footways and paths exclude motor traffic. Runways, taxiways and rail lines are outside the ground road network. Pedestrian use of ordinary streets is inferred, pending sidewalk details. Lower zoom geometry is generalized and must not be described as full street-level observed traffic. Actual flow and signal phases are separate inputs in subsequent tasks.

Provider and browser stream already forward complete GeographicTile objects without projection or attribute reconstruction; retaining attributes in the adapter decoder therefore requires no duplicate transformation in those layers. Tunnels stay available to routing but retain the previous exclusion from frozen surface-road cell normalization and from visible surface-street drawing.

## Movement model

Ground movement is simulated in fixed 1/30 s steps. A call advances at most 0.25 s, and a paused presentation clock supplies zero time. Vehicles retain their positions when the same network revision or the same external trip is supplied again. Removed routes exit the presentation simulation; they do not alter durable economic state.

Nominal lengths are 4.5 m (car/police), 12 m (bus), 10 m (truck/school bus) and 0.5 m (pedestrian). Following separation is half each participant's length plus 2 m. Vehicle and sidewalk queues are separate; newly supplied overlapping vehicles defer entry. Direction is taken from the local path tangent, including intermediate vertices. The terrain/deck height resolver is injected and changing it does not restart a trip.

Inferred junction control uses an explicitly **simulated** 50 s cycle: east-west green 20 s, yellow 3 s, clearance 2 s, then north-south with the same intervals. New entries stop during yellow; an entry admitted on green reserves its clearance. This is not a feed of real signal phases. Nominal speeds and hour-based rush slowdown are simulation assumptions, not real traffic observations. Population and traffic counts will calibrate demand separately. Generation is seeded, permission-checked and capped at 480 ground agents; a failed route does not spawn an agent. Lane-indexed queue lookups and cached eligible-edge pools bound repeated work.
