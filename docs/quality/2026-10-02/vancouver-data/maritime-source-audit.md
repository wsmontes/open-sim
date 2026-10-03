# Vancouver maritime sources

SeaBus uses route_type 4 and source shapes 322385/322386 from TransLink feed 26SEP_20261002. Water terminal coordinates are shape endpoints; landside GTFS boarding-stop coordinates are not used as vessel positions. Attribution and conditional TransLink terms are retained.

Aquabus has eight operator-confirmed named docks and seven consecutive routes. Coordinates and polylines come from OSM relation 10180776 and its full ways, checked against the operator’s current dock pages and 2026 network map. OSM opening hours are not adopted. Aquabus is kept distinct from False Creek Ferries, including their neighbouring Granville Island terminals. ODbL attribution retained.

Cargo and cruise corridors are derived around mapped coastlines and the First Narrows channel, not reported trajectories. CHS PAC201 August 2026 chapter5 supplies maintained channel depth15m, bridge clearance58.5m outside its centre and table5.3 berth depths: Canada Place8.5m and Centerm15m. These constrain representative simulated vessel dimensions; they are not a vessel-specific clearance or tidal model. Canada Place is passenger-only; Centerm is cargo-only. Water-side berth centres are derived offsets from OSM quay geometry. The offshore First Narrows anchor is not a public terminal.

Jericho’s marina polygon is OSM way54222106. Its derived English Bay recreational loop stays outside the Burrard Harbour sailing prohibition identified in the same CHS guide. Outings and identities are simulated; no private marina reservation or real boat track is claimed.

36 actual z14 coastal tiles were captured. Both initial large-ship corridors were rejected for land crossings; a native detailed-coast inspection corrected them. Final12 centre polylines pass segment/land intersection checks, not just endpoint checks. Only30m at floating-terminal endpoints is exempt from mapped pier land. No depth is inferred from absent data. Routes without verified geometry stay inactive; large-ship classes additionally require sourced navigation metadata and compatible terminal classes.

The official 2026 Canada Place calendar linked by the City was downloaded directly from Port of Vancouver: version1.12 April24. Its October page was rendered and visually checked. Three calls only are captured: Koningsdam west on October3, Eurodam east and Zaandam west on October4. Holland America’s official fleet page confirms company identity. The calendar has dates/berths, not arrival or departure hours: full-local-day display windows are explicitly derived, and cannot be presented as actual ETAs. This is a narrow dated capture, not a full annual calendar.

BC Ferries geometry, published sailings and civil-clock validity remain Task19; the common contract supports its vessel class without creating unscheduled boats. Capture hashes, source URLs and individual methods are retained in the JSON and audit. The coast proof is a native verification artifact; main scene integration remains Task22.

Verification: nine targeted maritime tests; full check869 passed/5 skipped; production build passed. Source/geometry previews inspected natively.
