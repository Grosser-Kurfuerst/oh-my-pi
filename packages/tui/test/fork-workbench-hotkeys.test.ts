import { afterEach, describe, expect, it } from "bun:test";
import { setKeyHintPlatform } from "@oh-my-pi/pi-tui/app-keybindings";
import { buildHotkeysMarkdown } from "@oh-my-pi/pi-tui/hotkeys-markdown";
import type { KeyId } from "@oh-my-pi/pi-tui/keybindings";

describe("/hotkeys workbench section", () => {
	afterEach(() => setKeyHintPlatform(undefined));

	it("lists the workbench shortcuts with their effective keys, unbound ones as disabled", () => {
		setKeyHintPlatform("linux");
		const keys: Record<string, KeyId[]> = {
			"fork.workbench.toggle": ["ctrl+b"],
		};
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				getKeys: action => keys[action] ?? [],
				getDisplayString: () => "",
				matchesCanonical: () => false,
			},
		});

		const section = markdown.slice(markdown.indexOf("**Workbench**"));
		expect(section).toContain("| `Ctrl+B` | Show or hide the fullscreen workbench |");
		expect(section).toContain("| `Disabled` | Focus the session list");
	});
});
