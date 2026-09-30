// The social card (task 17 of docs/superpowers/plans/2026-09-29-federated-world.md): the small public document somebody
// shares so another person can find a world. It is deliberately dumb — a title, a view URI, a link, the terms of the
// data it rests on and the capability declarations its issuer is willing to publish. Nothing here speaks to a network:
// the card is a value, and sharing it is a person's decision (ActivityPub included, through `worldCardDocument`, and
// only by explicit sharing; running an ActivityPub actor is a separate optional service, never a requirement of the
// game).
//
// One rule decides the shape of everything here: **a card never accepts private material by convenience**. The input is
// a closed set of declared fields, so a key, a snapshot, a grant or a proof cannot ride along in an extra field; an
// invalid input throws instead of producing a document that lies about what it contains; and what is about to leave
// the client is scanned for the two things a share file must never contain — a Nostr secret key and a PEM private key.
import {checkPublicCapability,checkWorldAddress,checkWorldLink} from '../../world/world-links';
import type {PublicCapability,WorldLink} from '../../world/world-links';
import {parseViewUri} from '../../world/osim';
import {failed,ok} from '../../world/model';
import type {DatasetTerm,JsonValue,WorldAddress,WorldResult} from '../../world/model';

export const WORLD_CARD_VERSION = 1;
// What a card may say, and nothing else. `id`, `view`, `actor` and every term are validated; `summary` is the only free
// text, which is exactly why the finished document is scanned before it is returned.
export type PublicWorldInfo = {
 id: string;
 world: WorldAddress;
 title: string;
 view: string;
 actor: string;
 link: WorldLink;
 terms: readonly DatasetTerm[];
 summary?: string;
 language?: string;
 publishedAt?: string;
 capabilities?: readonly PublicCapability[];
 session?: string;
};
export type PublicWorldCard = {
 kind: 'world-card';
 version: typeof WORLD_CARD_VERSION;
 id: string;
 world: WorldAddress;
 title: string;
 view: string;
 actor: string;
 link: WorldLink;
 terms: readonly DatasetTerm[];
 capabilities: readonly PublicCapability[];
 summary?: string;
 language?: string;
 publishedAt?: string;
 session?: string;
};

const FIELDS: readonly string[] = ['id','world','title','view','actor','link','terms','summary','language','publishedAt','capabilities','session'];
const URI = /^[a-z][a-z0-9+.-]*:[^\s\u0000-\u001f]{1,220}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
// Two shapes, and only two, because they are the ones a private key actually takes in this ecosystem.
const SECRETS: readonly RegExp[] = [/nsec1[02-9ac-hj-np-z]{20,}/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
const MAX_TEXT = 600;

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
// A function declaration (not an arrow assigned to a const) because TypeScript only treats a call as terminating the
// flow when the callee is declared as returning `never`, and everything below depends on that narrowing.
function refused(message: string): never {throw new Error(message);}
function requireText(value: unknown, label: string, pattern: RegExp, limit = MAX_TEXT): string {
 if (typeof value !== 'string' || !value.trim().length || value.length > limit) refused(`${label} inválido no cartão`);
 if (!pattern.test(value)) refused(`${label} não é um identificador válido no cartão`);
 return value;
}
// Nothing that looks like a secret leaves this client, whoever put it there and in whatever declared field.
function noSecrets(document: string): void {
 for (const marker of SECRETS) if (marker.test(document)) refused('O cartão não publica chave: o documento contém material privado');
}

export function createWorldCard(input: PublicWorldInfo): PublicWorldCard {
 const source = input as unknown;
 if (!plain(source)) refused('Cartão sem informação pública');
 // A field nobody declared is refused, not dropped: a caller that passed a snapshot or a key made a mistake, and a
 // document that silently omitted it would be worse than an error.
 for (const key of Object.keys(source)) if (!FIELDS.includes(key)) refused(`O cartão publica só o que declara: ${key}`);
 const id = requireText(source['id'], 'Identificador', URI);
 const title = requireText(source['title'], 'Título', /[\s\S]/);
 const address = checkWorldAddress(source['world']);
 if (!address.ok) refused(`Endereço do cartão inválido: ${address.error.message}`);
 const view = requireText(source['view'], 'Vista', URI);
 if (!parseViewUri(view).ok) refused(`A vista do cartão não é um URI de vista: ${view}`);
 const actor = requireText(source['actor'], 'Ator', URI);
 const link = checkWorldLink(source['link']);
 if (!link.ok) refused(`Link do cartão inválido: ${link.error.message}`);
 const terms = source['terms'];
 if (!Array.isArray(terms)) refused('O cartão precisa dos termos dos dados que ele aponta');
 const declared: DatasetTerm[] = [];
 for (const entry of terms) {
  if (!plain(entry) || typeof entry['source'] !== 'string' || !entry['source']) refused('Termo de dados inválido no cartão');
  const term: DatasetTerm = {source:entry['source']};
  for (const field of ['attribution','license'] as const) {
   if (entry[field] === undefined) continue;
   if (typeof entry[field] !== 'string' || !entry[field].length || entry[field].length > MAX_TEXT) refused(`${field} inválida no cartão`);
   term[field] = entry[field] as string;
  }
  declared.push(term);
 }
 const capabilities: PublicCapability[] = [];
 if (source['capabilities'] !== undefined) {
  if (!Array.isArray(source['capabilities'])) refused('As capacidades do cartão não são uma lista');
  for (const entry of source['capabilities']) {
   const capability = checkPublicCapability(entry);
   if (!capability.ok) refused(`Capacidade pública inválida no cartão: ${capability.error.message}`);
   capabilities.push(capability.value);
  }
 }
 const card: PublicWorldCard = {kind:'world-card', version:WORLD_CARD_VERSION, id, title, world:address.value, view, actor, link:link.value, terms:declared, capabilities};
 if (source['summary'] !== undefined) card.summary = requireText(source['summary'], 'Resumo', /[\s\S]/);
 if (source['language'] !== undefined) card.language = requireText(source['language'], 'Idioma', LANGUAGE, 24);
 if (source['publishedAt'] !== undefined) card.publishedAt = requireText(source['publishedAt'], 'Instante de publicação', INSTANT, 40);
 if (source['session'] !== undefined) {
  const session = requireText(source['session'], 'Sessão', URI);
  if (!session.startsWith('osim:session:')) refused(`A sessão do cartão não é uma sessão: ${session}`);
  card.session = session;
 }
 noSecrets(JSON.stringify(card));
 return card;
}

// The paste-ready text. It says what a person can do with it and what it does not mean, because the one dangerous
// misreading of a shared link is believing it carries permission.
export function worldCardText(card: PublicWorldCard): string {
 const lines: string[] = [card.title];
 if (card.summary) lines.push(card.summary);
 lines.push(`Mundo: ${card.world.worldId}/${card.world.branchId}${card.link.target.kind === 'commit' ? ` · versão fixa ${card.link.target.commit.hash.slice(0, 12)}…` : ' · ramificação que se move'}`);
 lines.push(`Abrir: ${card.view}`);
 lines.push(`Link: ${card.link.id}`);
 if (card.session) lines.push(`Sessão: ${card.session}`);
 for (const term of card.terms) lines.push(`Fonte: ${term.source}${term.attribution ? ` · ${term.attribution}` : ''}${term.license ? ` · ${term.license}` : ''}`);
 const actions = [...new Set(card.capabilities.flatMap(capability => capability.actions))];
 if (actions.length) lines.push(`Capacidades declaradas por ${card.actor}: ${actions.join(', ')} — a declaração é do emissor e visitar não concede permissão.`);
 else lines.push(`Publicado por ${card.actor}: visitar não concede permissão.`);
 return lines.join('\n');
}

// What an explicit share carries to a social client that speaks ActivityPub: a `Note` with the card attached as a
// document. There is no recipient and no audience field on purpose — addressing a community is the operator's decision,
// never a side effect of importing a file.
export function worldCardDocument(card: PublicWorldCard): JsonValue {
 return {
  type:'Note',
  id:card.id,
  attributedTo:card.actor,
  ...(card.publishedAt ? {published:card.publishedAt} : {}),
  content:worldCardText(card),
  attachment:[{type:'Document', mediaType:'application/json', name:'world-card.json', value:card as unknown as JsonValue}],
 };
}

// The card is its own document: reading one back is the same closed check the factory applies, so a card that arrived
// from somebody else is validated exactly like one this client built. Only the two fields the reader already consumed
// (`kind` and `version`) are removed first — everything else still has to be a declared field.
export function readWorldCard(value: unknown): WorldResult<PublicWorldCard> {
 if (!plain(value)) return failed('MALFORMED', 'Cartão ausente');
 const {kind, version, ...info} = value;
 if (kind !== 'world-card') return failed('MALFORMED', `Documento de tipo desconhecido: ${String(kind)}`);
 if (version !== WORLD_CARD_VERSION) return failed('WIRE_VERSION_UNSUPPORTED', `Versão de cartão ${String(version)} não é suportada (esperada ${WORLD_CARD_VERSION})`);
 try {
  return ok(createWorldCard(info as unknown as PublicWorldInfo));
 } catch (error) {
  return failed('MALFORMED', error instanceof Error ? error.message : String(error));
 }
}
