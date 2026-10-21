/**
 * Fork-only `/hotkeys` section for the workbench (custom branch), appended by
 * `hotkeyGroups` in hotkeys-markdown.ts. Keys come from the effective bindings,
 * so a rebinding in keybindings.yml shows up here.
 */
import type { KeybindingsManager } from "../app-keybindings";
import { formatKeyHint, type KeyName } from "../key-hint-format";
import type { FORK_KEYBINDINGS } from "./keybindings";

const ACTIONS: readonly [keyof typeof FORK_KEYBINDINGS, string][] = [
	["fork.workbench.toggle", "Show or hide the fullscreen workbench"],
	["fork.workbench.prevTurn", "Jump to the previous prompt (opens the workbench)"],
	["fork.workbench.nextTurn", "Jump to the next prompt"],
	["fork.workbench.sidebar", "Focus the session list; again to collapse or expand it"],
];

/** The workbench group: its bound keys, then the session list keys and the mouse. */
export function forkHotkeyGroup(keybindings: Pick<KeybindingsManager, "getKeys">) {
	const bound = (keys: readonly KeyName[]) =>
		keys.length > 0 ? { keys: keys.map(formatKeyHint), ids: keys } : { keys: ["Disabled"], ids: [] };
	return {
		title: "Workbench",
		rows: [
			...ACTIONS.map(([id, action]) => ({ keys: [bound(keybindings.getKeys(id))], action })),
			{
				keys: [{ token: "/" }, { text: " / " }, { token: "n" }],
				action: "In the session list: filter / new session (enter opens, esc returns to the prompt)",
			},
			{
				keys: [{ text: "Mouse" }],
				action: "Wheel scrolls; drag selects and copies; click the rail or a session to jump",
			},
		],
	};
}
