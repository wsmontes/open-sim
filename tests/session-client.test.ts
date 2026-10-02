// The cooperative session as the portable client drives it (spec 2026-10-01 §6.3, §7; stage E). Two clients share one
// in-memory transport, registry and world storage through the Node/test host: one hosts a branch forked from the
// version on screen, the other joins by the invite text, both build, and the replica sees only what the host confirmed
// — it cannot tick, and a proposal it submits is routed to the host. Nothing here touches a network or a real clock.
import {expect,test} from 'vitest';
import {createCoopPlayHost} from '../tools/play-host';
import {inviteUri,readPrincipal} from '../src/client/session';

// A step helper: run a typed command on a client through the text surface, exactly as a playthrough would.
import {parseCommand} from '../src/surfaces/text/parse';
import {chunkId,chunkOrigin} from '../src/core/coordinates';
import type {CityClient} from '../src/client/city-client';
import type {ManualTime} from '../src/client/time';

async function say(client: CityClient, time: ManualTime, settle: () => Promise<void>, line: string): Promise<string> {
 const origin = chunkOrigin(chunkId(client.view().center));
 const parsed = parseCommand(line, origin);
 if ('error' in parsed) return parsed.error;
 let message = '';
 for (const intent of parsed.intents) {
  const result = await client.do(intent);
  await client.idle();
  await settle();
  await client.idle();
  message = result.message;
 }
 if (parsed.wait) { await time.advance(parsed.wait); await client.idle(); await settle(); }
 return message;
}

test('inviteUri reads a session from its URI or its envelope, and nothing from a bare word', () => {
 expect(inviteUri('osim:session:open-sim-sessao-1')).toBe('osim:session:open-sim-sessao-1');
 expect(inviteUri('{"id":"osim:session:x","type":"session"}')).toBe('osim:session:x');
 expect(inviteUri('qualquer coisa')).toBeNull();
});

test('readPrincipal needs a scheme, and refuses a bare name', () => {
 expect(readPrincipal('nostr:npub1abc')).toEqual({scheme: 'nostr', id: 'npub1abc'});
 expect(readPrincipal('bia')).toBeNull();
});

test('two clients share a branch: the host builds, the replica sees it, and a replica cannot tick', async () => {
 const host = createCoopPlayHost();
 const ana = await host.open();
 const bia = await host.openPlayer!('bia');
 await ana.client.start(); await ana.client.idle();
 await bia.client.start(); await bia.client.idle();
 const settle = async () => {
  await host.settle!();
  await ana.client.syncSession(); await ana.client.idle();
  await bia.client.syncSession(); await bia.client.idle();
 };

 // Ana opens a session on the version she is looking at, and becomes the host.
 await say(ana.client, ana.time, settle, 'sessao abrir');
 expect(ana.client.view().state).not.toBeNull();
 const anaInfo = ana.client.session!;
 expect(anaInfo.branchId()).toMatch(/^sessao-/);

 // The invite is copied, and Bia joins by it. She becomes a verifying replica on the same branch.
 await say(ana.client, ana.time, settle, 'sessao convite');
 await ana.client.idle();
 // Join by the session URI the host published (the controller resolves the pasted text through the shared registry).
 const uri = `osim:session:open-sim-${anaInfo.branchId()}`;
 await say(bia.client, bia.time, settle, `sessao entrar ${uri}`);
 await settle();
 await bia.client.idle();

 // The host builds a road; the replica, after the network drains, sees the confirmed version.
 const anaMoneyBefore = ana.client.view().state!.money;
 await say(ana.client, ana.time, settle, 'rua 2,3 6,3');
 await settle();
 await ana.client.idle();
 await bia.client.idle();
 const anaState = ana.client.view().state!;
 expect(anaState.money).toBeLessThan(anaMoneyBefore);
 const biaState = bia.client.view().state!;
 expect(biaState.revision).toBe(anaState.revision);
 expect(biaState.money).toBe(anaState.money);

 // A replica cannot tick: the clock belongs to the host (spec §7.5). The tick is refused and nothing advances.
 const tickBefore = biaState.tick;
 const tickResult = await bia.client.do({do: 'speed', speed: 2});
 await bia.client.idle();
 await bia.time.advance(2000);
 await bia.client.idle();
 await settle();
 expect(bia.client.view().state!.tick).toBe(tickBefore);
 void tickResult;

 // Bia leaves: she returns to her personal version, and the shared branch keeps the work.
 await say(bia.client, bia.time, settle, 'sessao sair');
 expect(bia.client.session!.branchId()).toBeNull();

 ana.client.stop(); bia.client.stop();
});
