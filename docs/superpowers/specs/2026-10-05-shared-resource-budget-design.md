# Shared resource budgets

User preapproves autonomous implementation, verification and publication. Architectural follow-on to resource-ownership-design. Native inline execution; no repeated permission gates.

Goal: coordinate retained/render/network limits and degrade detail before transient work overwhelms the interface. Budgets cover estimated managed resources, not an exact browser-process or GPU-driver ceiling.

A resource policy derives one envelope from the device hint: raster baseline32/64/128MiB and managed envelope three times baseline. Explicit partitions reserve raster, scene geometry, encoded provider/selection, terrain source/selected/worker copies, mobility source geometry/network copies and network decode peaks; remaining space is state/derived-object headroom. Every partition comes from this policy, not independent whole-device allowances. No borrowing across workers until measured accounting can support it.

Network bodies have a size ceiling enforced while streaming, with chunk concatenation and concurrent provider responses reserved. Oversized map content is pressure, not a network failure. IndexedDB reads can still allocate a preexisting stored value before validation; disk data/player history is not deleted.

Terrain selection is capped by decoded tile bytes, prioritized near focus, drops departed selection before loading, limits concurrent work and reports incompleteness. Source cache has strict byte admission, disposal and aborted queues. Main and worker selection counts are accounted separately, source overlap conservatively counted.

Mobility selection retains only demanded tiles within its byte ceiling, ignores obsolete responses, limits construction edges from its network partition and clears departed caches. Both worker and yielded fallback decode under point/feature budgets before constructing geometry; selected decode has no inactive cache. All asynchronous publication carries a current ticket. Approximate per-edge accounting is an allocation estimate, not a proof of exact JS object sizes.

Geographic selection coarsens to fit coverage, then refines nearest coarse tiles into four children while remaining within maxTiles. The mosaic contains no ancestor/descendant overlap. Near source minimum is a quality target; insufficient budget keeps full coarse coverage and reports limited. Pressure must never silently leave peripheral holes. Quality recovery requires fresh healthy observations rather than treating idle time as proof of capacity.

Verification: deterministic budget sums on2/4/8/unknown devices, bounded response streams and cancellation, delayed obsolete mobility/terrain responses, near rotated full coverage at four-tile budget, non-overlapping refinement, fallback decoding and geometry quotas. Full suite/build and independent review; native foreground Chrome and long navigation when unlocked. Deployment gate must be clean, canonical build verified. No guaranteed absence of all browser stalls/context loss.
