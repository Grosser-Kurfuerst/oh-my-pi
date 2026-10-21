/**
 * Fork-only keybindings (custom branch). Merged into the global registry via
 * declaration merging and spread into `KEYBINDINGS` (app-keybindings.ts), so
 * users can rebind them in keybindings.yml like any upstream binding.
 */
import type { KeybindingDefinitions } from "../keybindings";

interface ForkKeybindings {
	"fork.workbench.toggle": true;
	"fork.workbench.prevTurn": true;
	"fork.workbench.nextTurn": true;
}

declare module "../keybindings" {
	interface Keybindings extends ForkKeybindings {}
}

export const FORK_KEYBINDINGS = {
	"fork.workbench.toggle": {
		defaultKeys: "ctrl+n",
		description: "Show or hide the fullscreen workbench",
	},
	"fork.workbench.prevTurn": {
		defaultKeys: "ctrl+up",
		description: "Workbench: jump to the previous prompt (opens the workbench)",
	},
	"fork.workbench.nextTurn": {
		defaultKeys: "ctrl+down",
		description: "Workbench: jump to the next prompt",
	},
} as const satisfies KeybindingDefinitions;
