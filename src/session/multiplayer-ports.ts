import type {Command, GameState} from '../core/model';
import {failed, ok} from '../world/model';
import type {WorldResult} from '../world/model';
import type {AuthorizedProposal} from '../world/permissions';
import type {WireMessage} from '../world/wire';

// The session layer's ports (docs/superpowers/specs/2026-09-29-federated-world-design.md §7.2, §9.1). The transport
// moves framed messages and knows nothing about economies, proposals or grants: the four classes of traffic the wire
// already declares decide only how a message has to be delivered (ordered and durable, best-effort and short-lived,
// or segmented), never what it means.

export type SessionListener = (peer: string, message: WireMessage) => void;
export interface SessionTransport {
 send(peer: string, message: WireMessage): Promise<void>;
 subscribe(listener: SessionListener): () => void;
}

// The command the host is about to apply. It is derived from the state the host actually accepted, not from the
// proposals it received: the core orders commands by its own per-actor sequence, and a proposal id is a different
// counter (spec §7.4), so a refused or repeated proposal leaves no gap for the next one to fall into.
export function commandFor(authorized: AuthorizedProposal, state: GameState): WorldResult<Command> {
 if (authorized.duplicate) return failed('CONFLICT', 'Proposta já aceita nesta ramificação e época');
 if (state.worldId !== authorized.proposal.worldId) return failed('CONFLICT', 'Mundo diferente da proposta');
 if (state.revision !== authorized.proposal.preconditions.revision) return failed('CONFLICT', 'A partida mudou desde a proposta');
 return ok({version: 1, worldId: state.worldId, actorId: authorized.actorId, sequence: (state.actors[authorized.actorId] ?? 0) + 1, expectedRevision: state.revision, action: authorized.proposal.intent});
}
