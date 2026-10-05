# Urban mobility rendering checkpoint

2026-10-03, native in-app browser, worktree Vite port 4174, 1280×720.

The browser and portable cell map use the shared mobility engine and vehicle/pedestrian drawing. Imported streets retain a z14 routing network independently of visual zoom, with four concurrent loads, a 64-tile cache and a viewport margin. Adding a tile remaps an existing agent through newly split intersections rather than resetting its trip. Demand starts inside the visible world bounds; its current 140 vehicle / 80 pedestrian targets and truck share are simulated assumptions, pending traffic-count calibration.

Cars, trucks and walkers have distinct bodies and heading projected through the camera. Bus, police and school-bus rendering is available to subsequent route/service tasks; no fleet or official service location is implied by those drawing helpers. Geographic agents share painter ordering with buildings; terrain occlusion and lane/sidewalk offsets apply. The distant draw limit is 120, otherwise 480.

Native observations: positions advanced while running and stayed byte-for-byte unchanged after pause in two successive diagnostics. Rotation and zoom were inspected. A combined camera glide initially moved the observation point tens of kilometres because it interpolated projection offsets; a regression test now checks intermediate Vancouver centers, and the client interpolates world centers. After correction the native center remained 49.283° N / 123.121° W throughout rotation.

Initial building bitmap cache churn caused roughly 269 ms median frames. Root-only building bitmaps, viewport culling, a bounded 64 MiB building cache, cached projected polygons and a single reusable ground bitmap reduced the observed steady Downtown median to 8–10 ms (p95 11–13 ms, native scheduler about 20 fps). Ground caching preserves separately animated water reflections and invalidates on camera, terrain, map tiles, edits, viewport and lighting changes. These observations are diagnostic, not the formal baseline comparison required by Task 22. Terrain's independent 32 MiB tile-cache budget is unchanged.

Checkpoint: `mobility-downtown-rotated.png`. Ground network, positions and visible-agent counts are exposed only through the existing debug mode. No real-time traffic positions are claimed.
