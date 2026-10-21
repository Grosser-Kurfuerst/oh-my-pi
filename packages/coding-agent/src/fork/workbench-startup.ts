/**
 * Fork-only: open the workbench on the startup prepaint composer, so the first
 * frame is already fullscreen instead of an inline prompt that switches over
 * once the session is ready. `installWorkbench` takes the shell over then.
 * Loaded on the prepaint path: keep app modules out of this import graph.
 *
 * Settings load after the prepaint, so whether to open comes from a small
 * cache next to the composer cache, rewritten by `installWorkbench` whenever
 * the settings disagree with it, and again when they change during the session.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { WorkbenchShell } from "@oh-my-pi/pi-tui/fork/workbench/shell";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import type { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import type { TUI } from "@oh-my-pi/pi-tui/tui";
import { getComposerCacheDbPath } from "@oh-my-pi/pi-utils/dirs";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as logger from "@oh-my-pi/pi-utils/logger";

let startupShell:
	| {
			readonly shell: WorkbenchShell;
			/** Removes its input routing and closes it. */
			readonly uninstall: () => void;
			readonly ui: TUI;
	  }
	| undefined;
/** What the cache said at this launch; undefined until read. */
let cachedOpen: boolean | undefined;

function startupCachePath(): string {
	return path.join(path.dirname(getComposerCacheDbPath()), "workbench.json");
}

/**
 * Whether this launch opens at prepaint: the cached `enabled && autoOpen`,
 * true when there is no cache yet. Under the test runner the user's cache is
 * never read, like the composer cache.
 */
function opensAtStartup(): boolean {
	if (cachedOpen === undefined) {
		cachedOpen = true;
		if (!isBunTestRuntime()) {
			try {
				// Sync: the prepaint frame cannot wait for a read.
				const cached: unknown = JSON.parse(fs.readFileSync(startupCachePath(), "utf8"));
				cachedOpen = !(typeof cached === "object" && cached !== null && "open" in cached && cached.open === false);
			} catch (err) {
				if (!isEnoent(err)) logger.debug("Workbench startup cache unreadable", { error: String(err) });
			}
		}
	}
	return cachedOpen;
}

/** Record what the next prepaint should do; writes only when it changed. */
export function rememberStartupOpen(open: boolean): void {
	// Tests share one process: a disabled workbench in one must not close the next one's prepaint.
	if (isBunTestRuntime() || open === opensAtStartup()) return;
	cachedOpen = open;
	Bun.write(startupCachePath(), JSON.stringify({ open })).catch(err =>
		logger.warn("Workbench failed to cache its startup setting", { error: String(err) }),
	);
}

/**
 * Open the workbench over the prepaint composer, hosting its editor until
 * InteractiveMode exists. A failure only costs the early open: startup stays inline.
 */
export function openStartupWorkbench(composer: Composer): void {
	if (isNativeRendering() || !opensAtStartup()) return;
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
		const shell = new WorkbenchShell(host);
		uninstall = shell.install();
		shell.open();
		startupShell = { shell, uninstall, ui: composer.ui };
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

/** Remove the shell the prepaint opened on `ui`, input routing included (the workbench is disabled). */
export function discardStartupWorkbench(ui: TUI): void {
	const pending = startupShell;
	startupShell = undefined;
	if (pending?.ui === ui) pending.uninstall();
}
