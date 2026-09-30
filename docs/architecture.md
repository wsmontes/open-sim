# Open Sim — Architecture Charter

Status: architectural direction for the interoperable-world phase.

Detailed proposal: [real-world data, versioned dimensions and federated collaboration](superpowers/specs/2026-09-29-federated-world-design.md), with a [staged implementation plan](superpowers/plans/2026-09-29-federated-world.md). These are planned capabilities, not a description of implemented networking.

## 1. Core idea

Open Sim is not fundamentally a city-building game. The city builder is the first client and the first ruleset exercising a more general world model.

The durable product is a portable, forkable world state rooted in real geography. Different clients may interpret and manipulate compatible parts of that state in different ways: a city builder can manage zoning and infrastructure, a life simulator can materialize households inside the same buildings, and a driving game can use the same road network and persistent places.

The architecture therefore treats **world semantics** as the stable center and treats rendering, gameplay genre, networking technology and storage as replaceable adapters.

A useful analogy is the Web or ActivityPub: applications can be very different while still exchanging objects and activities through a common contract. A useful simulation analogy is IEEE HLA: independent simulators ("federates") exchange a shared object model without requiring one simulator to contain every behavior.

## 2. Principles

### World first, game second

No domain concept should be placed in the shared protocol merely because the current city-builder needs it. City-builder-specific state belongs to a namespaced component or rules module.

### Serverless does not mean authorityless

A shared world needs a deterministic answer when two incompatible durable changes compete. The authority may run in a player's client, a peer-elected host, a community service or another process, but the role exists independently of deployment.

Transport does not determine authority. A Nostr signature proves who signed an event; it does not by itself grant permission to demolish a building or spend a city's money.

### Local first

A world can exist, run and be saved without a network. Networking is synchronization and discovery, not a prerequisite for the simulation core.

### Deterministic durable state

Given the same base snapshot, rules version and ordered durable commands, compatible implementations should derive equivalent durable state. Wall-clock time, frame rate, network arrival order and random APIs must not alter the result.

### Transport independence

Nostr, Matrix, WebRTC, libp2p, files on disk and browser storage are adapters. The world contract must remain meaningful if all of them are replaced.

### Extensibility by namespaced components

Clients must be able to preserve state they do not understand. A driving client does not need to implement household simulation; a life-sim client does not need to implement municipal finance.

### Real geography is a substrate, not mutable truth

OpenStreetMap and other public datasets seed the world. Player modifications live in an overlay. A world records which normalized base it adopted so that external map changes cannot silently rewrite history.

## 3. Layer model

Open Sim should be thought of as seven layers.

### Layer A — geographic substrate

Real-world source data such as OSM is normalized into deterministic, versioned geographic facts. The current 32×32 chunk representation is a valid engine representation, but it must not become the universal interoperability coordinate system.

The portable contract should describe Earth positions explicitly using named longitude, latitude and optional altitude fields. Individual engines can derive Web Mercator cells, local metres, 3D coordinates or another internal representation.

### Layer B — world lineage

Every world has a manifest describing its identity, protocol version, parent world if it is a fork, base geographic dataset/snapshot, ruleset family, authority configuration and extension declarations.

A world is therefore closer to a Git branch than to a globally unique mutable "Earth". Many users can start from the same Victoria or São Paulo and create incompatible universes without conflict.

### Layer C — durable semantic state

Durable things are entities with stable identifiers and versioned components.

Examples of generic component families:

- geo.position / geo.footprint
- place.name / place.address
- property.parcel / property.ownership
- structure.building
- infrastructure.road
- population.aggregate
- person.profile / person.residence
- vehicle.identity
- economy.account

Game-specific components remain namespaced, for example city.zone or lifesim.relationships.

Unknown components are preserved when possible and ignored by clients that do not implement them.

### Layer D — commands, events and snapshots

Commands express intent. An authority validates a command and produces an accepted transition/event. Durable events have stable IDs, actor identity, world identity, sequence/revision information and schema/rules versions.

Snapshots are checkpoints, not an alternative source of truth. Large snapshots and base chunks should be content-addressed and may live outside the event transport, with hashes in manifests or events.

The current Open Sim command envelope, per-actor sequence, global revision, canonical JSON and versioned snapshots are a good first implementation of this layer.

### Layer E — authority and scope

Authority is scoped rather than necessarily global.

A world may assign authority by:

- geographic shard;
- entity;
- component namespace;
- session;
- or a combination of these.

This lets a city simulation own municipal economy while a live driving session owns transient vehicle motion, without giving either subsystem permission to rewrite unrelated state.

Authorization is a world rule. Identity is merely evidence about the requester.

### Layer F — synchronization and transport

Different traffic classes should use different mechanisms.

**Durable, low-frequency data:** manifests, invitations, accepted commands, checkpoints and discovery metadata.

**Realtime, ephemeral data:** avatar/vehicle transforms, voice, cursor/selection state and other information that is useful now but does not need to become permanent history.

**Large blobs:** snapshots, assets, generated tiles and other content-addressed payloads.

Nostr is a strong candidate for identity, discovery, signed durable metadata and event distribution. Matrix is a viable optional adapter for rooms, permissions, chat and federation. WebRTC/libp2p-style channels are better suited to high-rate peer traffic. Content-addressed blob protocols such as Blossom are a better fit for large binary state than relay events.

The core must not require any one of these.

### Layer G — game profiles

A game profile declares which components and interactions it understands.

A city-builder profile can read geography/buildings and write zoning, infrastructure and municipal state.

A life-sim profile can read buildings/addresses and materialize households, residents and interiors.

A driving profile can read roads/places and participate in a realtime mobility session.

Profiles can overlap without being identical. Interoperability means they agree on the shared facts they exchange, not that every client implements the same game.

## 4. Multi-resolution simulation

The central architectural problem is that different games need different levels of detail for the same world.

A city-builder may represent a residential building as "64 residents". A life simulator needs named people. A traffic model may represent 500 cars as a flow rate, while a driving game needs one exact car with a position and velocity.

Open Sim should explicitly support **aggregation and materialization**.

An aggregate remains authoritative for quantities not currently materialized. When a higher-resolution client needs detail, it performs a deterministic materialization transaction that converts part of the aggregate into persistent or session-scoped entities while preserving invariants.

Example:

- building population aggregate = 64;
- four residents become materialized people;
- aggregate remainder becomes 60;
- total population invariant remains 64.

If those people later return to aggregate form, their relevant effects are folded back through a defined operation rather than simply deleted.

Materialization IDs must be deterministic or authority-issued so two clients cannot independently create different people for the same aggregate slot.

Some entities, once user-owned or historically significant, may become permanently materialized.

This is the bridge between SimCity-scale simulation and The-Sims/GTA-scale simulation. Distributed-simulation research calls this multi-resolution modeling and aggregation/disaggregation.

## 5. Durable versus ephemeral truth

Not everything visible in a client belongs in the permanent world.

Durable examples:

- a road was built;
- a building was demolished;
- ownership changed;
- a household moved;
- a persistent vehicle was purchased;
- a city's budget changed.

Ephemeral examples:

- exact avatar transform at 60 Hz;
- steering input;
- animation state;
- voice packets;
- camera position;
- temporary effects.

Realtime state may periodically create durable outcomes, but it should not flood the permanent event history.

A driving game may exchange vehicle transforms peer-to-peer while periodically committing meaningful world events such as parking, damage, ownership transfer or arrival.

## 6. Time model

Open Sim should distinguish:

1. wall-clock time used by interfaces and network metadata;
2. logical world time used by simulations;
3. realtime session time used for transient interactions.

Wall-clock timestamps must never decide ordering of competing durable commands.

Different game profiles do not need the same frame rate or simulation frequency. Cross-profile interoperability happens through versioned state transitions and explicit effective world time.

A global planet-wide tick is unnecessary and would be a scalability trap.

## 7. Spatial model

The existing engine uses a Web Mercator-derived integer grid with WORLD = 2^22 and 32×32 chunks. This is useful for deterministic city simulation and streaming.

For the interoperable protocol, geographic identity should remain independent of this engine grid:

- durable geographic points: longitude, latitude, optional altitude;
- footprints/paths: explicit geodetic geometry or references to content-addressed geometry;
- engine cells/chunks: derived addresses used by a specific rules implementation.

This keeps future 3D, driving, aviation or non-Mercator clients from inheriting a 2D city-builder assumption.

A world can still declare its shard/index scheme separately for discovery and authority routing.

## 8. World forks and sharing

A user-created universe should be cheap to fork.

A child world references a parent snapshot/manifest and stores only its divergent state. No global merge mechanism is required for the first protocol version.

World discovery can advertise lineage:

real-world base → Wagner's Victoria → friend's fork → temporary racing session.

Identity and selected portable entities may move between worlds, but a foreign world decides what it accepts. Teleporting identity does not imply importing all assets, money or permissions.

This separation avoids one of the classic virtual-world problems: treating identity portability, asset portability and world-state interoperability as if they were the same feature.

## 9. Network direction

### Nostr

Good fit for:

- public-key identity;
- signed world manifests;
- discovery;
- invitations;
- low-rate durable event publication;
- pointers to content-addressed snapshots/assets.

Relays are distribution/storage infrastructure, not game authorities.

### Matrix

Good fit for:

- persistent rooms;
- community membership;
- chat;
- federation;
- permission-oriented social spaces;
- signaling for realtime sessions.

Third Room demonstrates that Matrix can underpin decentralized virtual-world discovery, identity/social data and WebRTC game networking.

Matrix is heavier than Nostr and requires homeservers, so it should remain an adapter rather than a protocol dependency.

### WebRTC / libp2p

Good fit for:

- live positions;
- input streams;
- voice;
- short-lived session traffic.

Browser peer-to-peer still normally needs discovery, signaling and sometimes relay infrastructure. The design goal is therefore "no proprietary central game server required", not literally "no servers exist anywhere".

### Content-addressed blobs

World snapshots and large assets should be addressed by cryptographic hash. Nostr's Blossom ecosystem is one possible transport/storage adapter for this model.

## 10. What to keep from the current implementation

The present code already has several correct foundations:

- pure core separated from browser/network adapters;
- explicit worldId;
- deterministic integer ticks;
- canonical serialization;
- versioned rules and formats;
- base chunks frozen when adopted;
- player overlay separate from imported map;
- per-actor sequence numbers;
- global revision;
- replay protection;
- session orchestration outside core;
- map and storage ports.

These should be preserved.

## 11. What should not be generalized yet

Do not build a generic plugin bus, distributed consensus system, global economy, blockchain, universal avatar format or automatic world merge before a second game profile proves the need.

The next architecture proof should be intentionally small:

1. city-builder writes a durable shared fact;
2. a second minimal client reads that fact through the portable world format;
3. the second client writes one compatible fact of its own;
4. the city-builder observes the effect without knowing the second client's implementation.

A tiny "resident/vehicle explorer" is enough. The purpose is to prove semantic interoperability, not graphical sophistication.

## 12. Architectural tests

Before calling the protocol viable, prove these scenarios:

- two implementations replay the same base + commands and reach equivalent durable state;
- a client can ignore and preserve unknown component namespaces;
- a world can fork from a manifest without copying the entire parent;
- stale/replayed commands cannot double-spend or duplicate construction;
- realtime movement can disappear without corrupting durable state;
- a high-resolution client can materialize part of an aggregate while preserving totals;
- losing a relay does not destroy a locally available world;
- transport adapters can be swapped without changing core rules;
- a second game profile can interact with the same place without importing city-builder rendering or UI code.

### 12.1 The published interoperability package

The boundary these scenarios are tested against is the **OpenSim 0.1** protocol; what this client publishes there, and
what a third party can repeat, is written down in [`docs/protocol/world-v2.md`](protocol/world-v2.md):

- `schemas/world-v2/*.schema.json` describe the objects this client emits (envelope, entity, event, session,
  capability, version objects, link, card), and `tests/world-conformance.test.ts` checks the code against them;
- `tests/fixtures/federated-world/conformance.json` (CC0-1.0, synthetic) is reproduced byte for byte — same state
  address and same semantic hash — by the Node runner and by the browser page, and `tools/world-replay.ts` runs the
  package plus the §47 checklist;
- [`docs/protocol/adapters.md`](protocol/adapters.md) lists every port, who implements it and which capabilities were
  exercised against a real service, which are contract only and which are future.

The §47 checklist (`tests/osim-boundary.test.ts`, `tools/world-replay.ts`) is the enumeration of those scenarios that
this client can already answer for itself; the plan's execution table records, per task, the evidence for the rest.

## 13. Relevant precedents

Open Sim should learn from, not clone, several prior systems:

- **IEEE HLA** — federates, shared object models, authority/time-management concepts for heterogeneous distributed simulations.
- **Multi-resolution simulation literature** — aggregation/disaggregation between coarse and entity-level models.
- **OpenSimulator Hypergrid** — independently operated worlds, portable identity and teleport/handoff between grids.
- **Second Life Open Grid Protocol work** — early attempts to specify login/teleport/inter-grid contracts separately from one server implementation.
- **VATSIM** — different simulator clients (MSFS, X-Plane, FlightGear, etc.) participate in one shared airspace through a common network contract.
- **EVE Online + DUST 514** — a concrete cross-genre shared-universe example where events in one game affected another.
- **Matrix Third Room** — open decentralized virtual worlds, portable social data, glTF/WebAssembly and realtime networking over Matrix.
- **Croquet OS** — deterministic replicated simulation with shared logical time, useful as a reference even though its reflector architecture differs from Open Sim's goals.
- **ActivityPub** — heterogeneous applications interoperating because the shared protocol describes actors/objects/activities rather than one UI.
- **Automerge/Yjs** — useful local-first and CRDT references for collaboratively edited documents, but not a substitute for authoritative game transitions when invariants such as money, ownership and collision matter.

## 14. Sources

- IEEE HLA 1516 overview: https://standards.ieee.org/ieee/1516/6687/
- IEEE HLA federate interface: https://standards.ieee.org/ieee/1516.1/6688/
- OpenSimulator Hypergrid concepts: https://opensimulator.dev/wiki/Hypergrid_Concepts
- Second Life Grid Protocols: https://wiki.secondlife.com/wiki/Second_Life_Grid_Protocols
- Matrix specification: https://spec.matrix.org/latest/
- Third Room: https://github.com/matrix-org/thirdroom
- Nostr NIP-01: https://github.com/nostr-protocol/nips/blob/master/01.md
- Nostr NIP-B7 / Blossom: https://github.com/nostr-protocol/nips/blob/master/B7.md
- libp2p pubsub: https://libp2p.io/docs/pubsub/
- ActivityPub: https://www.w3.org/TR/activitypub/
- Automerge: https://automerge.org/docs/
- Yjs: https://docs.yjs.dev/
