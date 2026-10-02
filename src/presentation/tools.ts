import type {Tool} from '../core/model';
// What the player can hold in their hand: a tool that builds, the demolisher, or nothing (explore). It is surface
// vocabulary shared by every surface, so it lives apart from any one of them.
export type SelectedTool = Tool|'explore'|'demolish';
export const SELECTED_TOOLS: readonly SelectedTool[] = ['explore','road','avenue','highway','residential','commercial','industrial','park','power','demolish'];
export const TOOL_LABELS: Record<Tool,string> = {road:'Rua',avenue:'Avenida',highway:'Estrada',residential:'Residencial',commercial:'Comércio',industrial:'Indústria',park:'Parque',power:'Usina'};
// A zone is a rectangle and everything else is a line: how the genre taught players to lay a neighbourhood down.
const BOX_TOOLS: ReadonlySet<SelectedTool> = new Set<SelectedTool>(['residential','commercial','industrial','park']);
export const strokeShapeOf = (tool: SelectedTool): 'line'|'box' => BOX_TOOLS.has(tool) ? 'box' : 'line';
