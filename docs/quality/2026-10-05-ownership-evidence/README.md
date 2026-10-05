# Resource ownership validation — 2026-10-05

Source commit: 73e2f1d. Full checks: 152 files, 1059 tests passed, 5 skipped; typecheck and build passed. Existing ten lint warnings and bundle-size warning remain.

Native foreground Chrome validation before publication: neighborhood50m → regional20km → rotated/night continent200km → planet → neighborhood50m/day/north; buildings visible on return. Planet released selected regional geometry (estimated bytes0). Neighborhood geometry estimate5,114,144 bytes; settled worker7.1ms and UI frame p95 2.6ms. Short3× simulation sample UI p95 3.2ms, worker14.5ms. These observations are not controlled process/GPU memory measurements or cross-device performance guarantees.

Screenshot local-neighborhood.png captures the validated returned neighborhood. Automated regressions additionally exercise strict byte admission, oversized tiles, departed resources, worker failure reprojection, bounded retry, empty pressured-frame preservation, geometry point limits and explicit partial-coverage reporting.

Publication uses the repository gate (full check/build, clean tree). Final foreground production validation was interrupted when macOS locked; do not present the local screenshot as production evidence. Verify Pages deployment and canonical asset identity independently.

Remaining architecture work: shared peak budget across terrain/mobility/network decoding, and coarse peripheral coverage when low budgets prioritize central near-view detail. See resource ownership design for scoped guarantees.
