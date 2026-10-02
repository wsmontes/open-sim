// A compatibility shim. The portable cooperative-session view (createGameSessionView, the links, the descriptor and
// presence helpers) lives in session-view.ts; the DOM panel moved to src/surfaces/canvas/multiplayer-panel.ts and the
// invite-text helper to src/adapters/session/descriptor.ts (both need a host global). This module keeps one place for
// the portable half so existing importers are unchanged, and it compiles without DOM (tsconfig.presentation.json).
export * from './session-view';
