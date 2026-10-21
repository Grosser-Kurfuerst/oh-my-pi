/**
 * Fork-only workbench settings (custom branch), listed through `DOMAINS` in
 * `config/all-settings.ts`. Both are read when the workbench installs, so a
 * change applies from the next launch.
 */
import { combine, register } from "../config/registry";

export const cfgWorkbenchEnabled = register({
	id: "fork.workbench.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Workbench",
		description:
			"Fullscreen workbench with a session list and prompt navigation; off frees its shortcuts (next launch)",
	},
});

export const cfgWorkbenchAutoOpen = register({
	id: "fork.workbench.autoOpen",
	type: "boolean",
	default: true,
	ui: {
		tab: "appearance",
		group: "Display",
		label: "Open Workbench at Startup",
		description: "Start in the workbench instead of the inline prompt (next launch)",
	},
});

/** Whether a launch opens the workbench: what the startup cache records for the next prepaint. */
export const cfgWorkbenchStartsOpen = combine(
	{ enabled: cfgWorkbenchEnabled, autoOpen: cfgWorkbenchAutoOpen },
	({ enabled, autoOpen }) => enabled && autoOpen,
);
