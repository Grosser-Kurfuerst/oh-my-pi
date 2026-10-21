/**
 * Fork-only: open the workbench on the startup prepaint composer, so the first
 * frame is already fullscreen instead of an inline prompt that switches over
 * once the session is ready. `installWorkbench` takes the shell over then.
 * Loaded on the prepaint path: keep app modules out of this import graph.
 */
import { WorkbenchShell } from "@oh-my-pi/pi-tui/fork/workbench/shell";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import type { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import type { TUI } from "@oh-my-pi/pi-tui/tui";
import * as logger from "@oh-my-pi/pi-utils/logger";

let startupShell: { readonly shell: WorkbenchShell; readonly ui: TUI } | undefined;

/**
 * Open the workbench over the prepaint composer, hosting its editor until
 * InteractiveMode exists. A failure only costs the early open: startup stays inline.
 */
export function openStartupWorkbench(composer: Composer): void {
	if (isNativeRendering()) return;
	let uninstall: (() => void) | undefined;
	try {
		const host = {
			ui: composer.ui,
			editorContainer: {
				get children() {
					return [composer.editor];
				},
			},
		};
		// Input is still deferred (cooked tty); mouse reports would echo onto the frame until the takeover.
		const shell = new WorkbenchShell(host, { mouseTracking: false });
		uninstall = shell.install();
		shell.open();
		startupShell = { shell, ui: composer.ui };
	} catch (err) {
		// Leave nothing half open: installWorkbench would stack a second shell on it.
		uninstall?.();
		logger.warn("Workbench failed to open at startup", { error: String(err) });
	}
}

/** The shell opened at prepaint on `ui`, handed out once; undefined when startup opened none there. */
export function takeStartupWorkbench(ui: TUI): WorkbenchShell | undefined {
	const pending = startupShell;
	startupShell = undefined;
	return pending?.ui === ui ? pending.shell : undefined;
}
