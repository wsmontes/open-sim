# Research Notes — Interoperable Worlds and Cross-Game Simulation

Status: research input for Open Sim architecture. This document records precedents and the specific lesson each provides.

## Why this research matters

The Open Sim idea is more specific than a conventional "metaverse". The target is not merely portable avatars or 3D assets. The target is **multiple kinds of simulations interacting with compatible facts in the same world**.

A city builder, life simulator and driving game may render completely different experiences and run at different resolutions, but they should be able to agree that a particular road, building, household, vehicle or event exists and that an authorized change in one simulation can have a defined effect in another.

That makes the closest precedents come from several different families rather than one existing product.

## IEEE High Level Architecture (HLA)

HLA is a standard architecture for connecting independently developed simulations. Participating simulations are "federates"; together they form a "federation". Shared object models describe the information they exchange, while runtime infrastructure handles coordinated communication.

The most important lesson for Open Sim is conceptual: **interoperability does not require one simulator to own every behavior**.

A city simulator and a driving simulator can remain independent implementations if they share explicit contracts for the facts and interactions that cross their boundary.

Useful ideas to borrow:

- federates as independent simulation domains;
- a shared object model;
- publish/subscribe ownership of classes of data;
- explicit time/order concerns;
- clear distinction between simulation semantics and transport/runtime infrastructure.

What not to copy directly:

- HLA's full middleware and operational complexity;
- assumptions shaped by managed simulation facilities;
- a single mandatory RTI.

Open Sim can keep the conceptual separation while using small JSON/binary contracts and pluggable transports.

Sources:

- https://standards.ieee.org/ieee/1516/6687/
- https://standards.ieee.org/ieee/1516.1/6688/
- https://standards.ieee.org/ieee/1516.2/

## Multi-resolution modeling and aggregation/disaggregation

This is the research area most directly related to the "SimCity + The Sims + GTA" idea.

Multi-resolution simulations allow different models to represent the same system at different levels of detail. A coarse simulation may model an aggregate unit; a detailed simulation can disaggregate that unit into individual entities when necessary and later aggregate results back.

Research examples explicitly discuss concurrent coarse and entity-level models, resolution switching, and maintaining consistency during aggregation/disaggregation.

For Open Sim this maps naturally to:

- population count ↔ individual residents;
- traffic flow ↔ individual cars;
- business activity totals ↔ individual shops/customers;
- building occupancy ↔ households/rooms/people.

The key architectural requirement is not "generate more detail". It is **preserve invariants across the resolution boundary**.

If a building has 64 residents and four are materialized as individuals, the city simulation must not still count 64 anonymous residents plus those four.

This suggests a first-class materialization protocol rather than ad-hoc procedural generation inside each client.

Sources:

- https://trid.trb.org/View/1349332
- https://www.mdpi.com/2078-2489/11/10/469
- https://journals.sagepub.com/doi/full/10.1177/00375497221107940

## OpenSimulator and Hypergrid

OpenSimulator provides independently operated virtual-world regions/grids. Hypergrid lets avatars move between independently operated grids without those grids sharing one central set of services.

Its architecture includes concepts such as gatekeepers, home services and region handoff.

Important lesson: identity/location handoff and world ownership can be decentralized.

Even more useful is what Hypergrid does **not** solve for Open Sim: it largely connects compatible virtual-world implementations with shared Second-Life-style semantics. It is not primarily a mechanism for a city simulator and a driving simulator to own different resolutions of the same semantic world.

Open Sim should therefore borrow federation, world autonomy and handoff ideas without inheriting a single virtual-world gameplay model.

Sources:

- https://opensimulator.dev/wiki/Hypergrid_Concepts
- https://opensimulator.dev/wiki/Installing_and_Running_Hypergrid
- https://opensimulator.dev/wiki/Teleports
- https://opensimulator.dev/wiki/FAQ

## Second Life Open Grid Protocol work

The Second Life Architecture Working Group separated grid interoperability concerns such as foundation protocols, login and teleport from one monolithic implementation.

The historical public beta demonstrated login/teleport between Second Life and participating OpenSim simulators, but did not attempt broad asset transfer.

That is a useful warning: "interoperability" is not one feature. Identity portability, presence, teleport, assets, permissions and world state are separate problems and should be specified separately.

Sources:

- https://wiki.secondlife.com/wiki/Second_Life_Grid_Protocols
- https://wiki.secondlife.com/wiki/AWG
- https://wiki.secondlife.com/wiki/Open_Grid

## VATSIM

VATSIM is one of the cleanest real-world analogies for Open Sim.

Different flight simulators participate in the same shared airspace using adapter/client software. As of August 2026, VATSIM officially supports Microsoft Flight Simulator, X-Plane, Prepar3D and older simulators/FlightGear through different pilot clients.

The simulators do not share renderers, physics engines or scenery code. They exchange the subset of facts required for network interoperability.

This is almost exactly the protocol philosophy Open Sim needs:

**do not standardize the game; standardize the facts games need to share.**

A GTA-like client and a city-builder client should not need the same physics. They need a shared contract for the road, vehicle identity and meaningful durable outcomes.

Source:

- https://vatsim.net/docs/policy/approved-software/

## EVE Online and DUST 514

DUST 514 and EVE Online were different genres on different platforms sharing the same fictional universe.

A visible integration was orbital bombardment: a DUST player could designate a ground target and an EVE player in orbit could fire into the DUST battle. DUST battles also participated in EVE's broader faction-war context.

This is valuable because it proves that cross-game interoperability can be meaningful even when only a small set of carefully chosen interactions crosses the boundary.

Open Sim should prefer a handful of semantically strong cross-game interactions over attempting to synchronize every subsystem.

Source:

- https://wiki.eveuniversity.org/Dust_514%3A_Orbital_Bombardment

## Matrix and Third Room

Matrix models rooms as event graphs with persistent state events and deterministic state-resolution rules. It also permits custom event types.

Third Room was built explicitly as open, decentralized immersive worlds on Matrix. Its design combines Matrix for identity/social/federated data with WebRTC-style game networking and glTF/WebAssembly for portable world content/behavior.

The strongest lesson for Open Sim is architectural layering:

- durable social/world metadata over a federated event system;
- realtime media/game traffic over more suitable channels;
- portable world assets in open formats;
- multiple possible clients implementing the protocol.

Matrix is a serious option for a social/community adapter, but it is heavier than the minimal Open Sim core and requires homeserver infrastructure.

Sources:

- https://spec.matrix.org/latest/
- https://github.com/matrix-org/thirdroom
- https://thirdroom.io/

## Nostr

Nostr's base protocol is intentionally small: signed events identified by hashes, public-key authors, kinds/tags and relay-based distribution.

This fits several Open Sim needs unusually well:

- actor identity by key;
- signed world manifests;
- world discovery;
- invites and low-rate control events;
- replication across multiple relays;
- transport independence from one provider.

Nostr should not become the simulation's consensus mechanism. Relays store/distribute events; they do not answer domain questions such as whether an actor may spend money, mutate a parcel or win a collision.

NIP-01 distinguishes regular, replaceable, ephemeral and addressable events, which may become useful for manifests and session metadata.

NIP-B7 connects Nostr clients to Blossom, where blobs are addressed by SHA-256. That is attractive for large snapshots, base chunks and assets because the event network can carry metadata/hashes while blob servers carry bytes.

Sources:

- https://github.com/nostr-protocol/nips/blob/master/01.md
- https://github.com/nostr-protocol/nips/blob/master/65.md
- https://github.com/nostr-protocol/nips/blob/master/B7.md

## ActivityPub

ActivityPub is important less as an implementation candidate and more as an existence proof.

It lets applications with completely different codebases and interfaces participate in one social graph because the common layer describes actors, objects and activities.

W3C specifically notes interoperability between applications such as Mastodon and PeerTube.

The analogy for Open Sim is direct:

- Mastodon and PeerTube need not become the same application;
- city builder and driving game need not become the same game.

The shared protocol should express the small set of interoperable world concepts and activities.

Sources:

- https://www.w3.org/TR/activitypub/
- https://www.w3.org/TR/social-web-protocols/

## Croquet OS

Croquet demonstrates deterministic replicated simulation: clients run equivalent shared computation while a lightweight reflector orders/distributes events with shared logical time. New clients recover from saved state plus subsequent events.

This closely resembles the deterministic direction already present in Open Sim.

The important lesson is that event ordering and logical time can be extremely small infrastructure responsibilities even when simulation runs on clients.

The difference is strategic: Open Sim should not require Croquet's reflector network or one vendor/runtime. It can use the design as evidence that deterministic local execution plus ordered input is viable.

Sources:

- https://croquet.io/croquet-os/
- https://croquet.io/faq/

## libp2p and WebRTC

libp2p's pub/sub model shows how realtime peers can organize around topics without a central message broker, while its browser WebRTC documentation also makes the practical limits clear: peer discovery and connectivity still need bootstrapping/relay mechanisms.

The lesson is to avoid the phrase "no servers" as a technical requirement. The useful requirement is:

**no proprietary always-on central game server is required for the world to exist.**

Sources:

- https://libp2p.io/docs/pubsub/
- https://docs.libp2p.io/guides/webrtc-browser-connectivity/

## Automerge and Yjs

Automerge and Yjs are excellent references for local-first replicated data.

Both separate the data model from transport; both can work with multiple networking/storage adapters; disconnected peers can keep working and synchronize later.

They are attractive for collaborative authoring state such as:

- world descriptions;
- annotations;
- editor layouts;
- lists;
- perhaps non-exclusive decorative object placement.

They are not automatically the right answer for all simulation state.

If two users concurrently spend the same money, buy the same unique parcel or apply incompatible physics outcomes, a CRDT can merge the data structure while still producing a domain-invalid game state.

Open Sim should therefore use CRDT techniques selectively, not make "everything is a CRDT" a foundational rule.

Sources:

- https://automerge.org/docs/reference/concepts/
- https://automerge.org/docs/reference/repositories/
- https://docs.yjs.dev/

## Open Metaverse Interoperability Group (OMI)

OMI's glTF extension work is useful for portable media and scene semantics such as physics bodies, audio, seats, spawn points and vehicle concepts.

This can become relevant if Open Sim grows from a 2D city renderer into 3D clients.

However, glTF interoperability mainly addresses portable assets/scenes, not authoritative shared simulation state. It belongs beside the world protocol, not underneath it.

Sources:

- https://omigroup.org/
- https://github.com/omigroup/gltf-extensions

## Synthesis

No single precedent implements the exact Open Sim idea.

The closest combination is:

- **HLA** for heterogeneous simulation boundaries;
- **multi-resolution modeling** for SimCity ↔ The Sims/GTA granularity;
- **VATSIM** for many engines participating through a narrow common protocol;
- **Hypergrid** for autonomous worlds and handoff;
- **ActivityPub/Nostr** for protocol-first heterogeneous clients and identity/discovery;
- **Third Room/Matrix** for decentralized virtual-world social infrastructure;
- **Croquet** for deterministic replay and shared logical time;
- **Automerge/Yjs** for selected local-first collaborative state.

The architectural opportunity is to combine those ideas around a real-geography substrate while keeping the first implementation intentionally tiny.

## Recommended experiments

The next proof should not be full multiplayer.

Create a second tiny client/profile that shares the same portable world but has a different purpose.

Candidate experiment:

1. city-builder creates or modifies a residential building;
2. save/export a world snapshot;
3. a "street/resident explorer" opens the same world and reads the building;
4. it materializes one household or one persistent vehicle using a versioned extension component;
5. save the result;
6. the city-builder reloads the world, ignores details it does not understand, but reflects the compatible aggregate effect.

If this works without either client importing the other's rendering/gameplay code, Open Sim has proven the important part of the architecture.
