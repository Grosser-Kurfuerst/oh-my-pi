/**
 * Fork-only keybindings (custom branch). Merged into the global registry via
 * declaration merging and spread into `KEYBINDINGS` (app-keybindings.ts), so
 * users can rebind them in keybindings.yml like any upstream binding.
 */
import type { KeybindingDefinitions } from "../keybindings";

interface ForkKeybindings {
	"fork.workbench.toggle": true;
}

declare module "../keybindings" {
	interface Keybindings extends ForkKeybindings {}
}

export const FORK_KEYBINDINGS = {
	"fork.workbench.toggle": {
		defaultKeys: "ctrl+n",
		description: "Show or hide the fullscreen workbench",
	},
} as const satisfies KeybindingDefinitions;
