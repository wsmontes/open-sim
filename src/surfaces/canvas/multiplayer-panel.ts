// The canvas-surface panel of a cooperative session (spec 2026-10-01 §6): a .panel card the player reads and acts on.
// The portable half (createGameSessionView, the links, the descriptor and presence helpers) lives in
// presentation/session-view.ts; this file is only the DOM, so it belongs to the canvas surface.
import type {MultiplayerInfo} from '../../presentation/session-view';

// The card the player reads: the branch, who is in it, the session descriptor and the save states the spec names. It
// is a `.panel` like the others, so `hud.ts` picks it up as one more draggable card. MultiplayerInfo (the model it
// renders) comes from session-view.
export type MultiplayerActions = {
 onCreate: () => void;
 onJoin: (text: string) => void;
 onInvite: () => void;
 onLeave: () => void;
 onContinueLocal: () => void;
 // The pause stops the epoch this device orders; the transfer takes the actor of the successor from the same field the
 // invite uses, because naming who receives the branch is the player's decision and not a default of the client.
 onPause: () => void;
 onTransfer: (text: string) => void;
};
export type MultiplayerPanel = {update(info: MultiplayerInfo): void;destroy(): void};

export function createMultiplayerPanel(root: HTMLElement, actions: MultiplayerActions): MultiplayerPanel {
 const doc = root.ownerDocument;
 const make = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = doc.createElement(tag);
  if(className)node.className = className;
  if(text !== undefined)node.textContent = text;
  return node;
 };
 const button = (text: string, id: string): HTMLButtonElement => {
  const node = doc.createElement('button');
  node.type = 'button';
  node.id = id;
  node.textContent = text;
  return node;
 };
 const panel = make('section', 'panel');
 panel.id = 'panel-multiplayer';
 panel.dataset.panel = 'multiplayer';
 panel.dataset.sheet = 'pessoas';
 panel.setAttribute('aria-label', 'Sessão cooperativa');
 panel.style.left = '8px';
 panel.style.top = '480px';
 panel.style.width = 'min(320px,calc(100vw - 16px))';
 const head = make('header', 'panel-head');
 head.dataset.dragHandle = '';
 const title = make('h2', 'panel-title', 'Sessão');
 const collapse = button('▾', 'multiplayer-collapse');
 collapse.className = 'panel-close';
 collapse.dataset.close = '';
 collapse.setAttribute('aria-expanded', 'true');
 collapse.setAttribute('aria-label', 'Minimizar painel Sessão');
 collapse.title = 'Minimizar painel';
 head.append(title, collapse);
 const body = make('div', 'panel-body');
 body.dataset.panelBody = '';
 const where = make('p', 'multiplayer-where');
 where.id = 'multiplayer-where';
 const statusLine = make('p', 'multiplayer-status');
 statusLine.id = 'multiplayer-status';
 statusLine.setAttribute('role', 'status');
 const detailLine = make('p', 'multiplayer-detail');
 detailLine.id = 'multiplayer-detail';
 const people = make('ul', 'multiplayer-participants');
 people.id = 'multiplayer-participants';
 const presentLine = make('p', 'multiplayer-presence');
 presentLine.id = 'multiplayer-presence';
 const descriptorLine = make('p', 'multiplayer-descriptor');
 descriptorLine.id = 'multiplayer-descriptor';
 const inviteText = doc.createElement('textarea');
 inviteText.id = 'multiplayer-invite';
 inviteText.className = 'multiplayer-invite';
 inviteText.rows = 3;
 inviteText.spellcheck = false;
 inviteText.setAttribute('aria-label', 'Convite ou oferta da sessão');
 const create = button('Criar sessão', 'multiplayer-create');
 const share = button('Convidar', 'multiplayer-invite-button');
 const join = button('Entrar', 'multiplayer-join');
 const leave = button('Sair', 'multiplayer-leave');
 const pause = button('Pausar partida', 'multiplayer-pause');
 const transfer = button('Transferir sessão', 'multiplayer-transfer');
 const personal = button('Continuar em versão pessoal', 'multiplayer-personal');
 const controls = make('div', 'multiplayer-controls');
 controls.append(create, share, join, leave, pause, transfer, personal);
 const messageLine = make('p', 'multiplayer-message');
 messageLine.id = 'multiplayer-message';
 messageLine.setAttribute('role', 'alert');
 body.append(where, statusLine, detailLine, people, presentLine, descriptorLine, inviteText, controls, messageLine);
 panel.append(head, body);
 root.append(panel);
 let written = '';
 const listen = <E extends Event>(target: EventTarget, type: string, handler: (event: E) => void) => {
  const listener = handler as EventListener;
  target.addEventListener(type, listener);
  return () => target.removeEventListener(type, listener);
 };
 const forget: (() => void)[] = [];
 forget.push(listen(create, 'click', () => actions.onCreate()));
 forget.push(listen(share, 'click', () => actions.onInvite()));
 forget.push(listen(join, 'click', () => actions.onJoin(inviteText.value)));
 forget.push(listen(leave, 'click', () => actions.onLeave()));
 forget.push(listen(pause, 'click', () => actions.onPause()));
 forget.push(listen(transfer, 'click', () => actions.onTransfer(inviteText.value)));
 forget.push(listen(personal, 'click', () => actions.onContinueLocal()));
 return {
  update(info) {
   where.textContent = `${info.worldId}/${info.branchId} · ${info.modeLabel} · ${info.head}`;
   statusLine.textContent = info.pending ? `${info.status.text} · ${info.pending} em andamento` : info.status.text;
   statusLine.setAttribute('data-state', info.status.kind);
   detailLine.textContent = info.status.detail;
   detailLine.hidden = !info.status.detail;
   people.replaceChildren();
   for(const participant of info.participants)people.append(make('li', undefined, `${participant.id} — ${participant.role}`));
   presentLine.textContent = info.presence.length ? `Presentes (efêmero): ${info.presence.join(', ')}` : '';
   presentLine.hidden = !info.presence.length;
   descriptorLine.textContent = info.descriptor ? `Descritor: ${info.descriptor}` : 'Sem sessão aberta';
   // The field is the player's clipboard as much as the invite's: it is only rewritten when the invite itself changed.
   if(info.invite !== written){
    written = info.invite;
    inviteText.value = info.invite;
   }
   create.hidden = !info.canCreate;
   share.hidden = !info.canInvite;
   join.hidden = !info.canJoin;
   leave.hidden = !info.canLeave;
   pause.hidden = !info.canPause;
   transfer.hidden = !info.canTransfer;
   personal.hidden = !info.canContinueLocal;
   messageLine.textContent = info.message;
   messageLine.hidden = !info.message;
  },
  destroy() {
   for(const stop of forget)stop();
   panel.remove();
  },
 };
}
