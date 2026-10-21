/**
 * Fork-only: open the workbench on the startup prepaint composer, so the first
 * frame is already fullscreen instead of an inline prompt that switches over
 * once the session is ready. `installWorkbench` takes the shell over then.
 * Loaded on the prepaint path: keep app modules out of this import graph.
 *
 * Settings load after the prepaint, so whether to open comes from a small
 * cache next to the composer cache, rewritten by `installWorkbench` whenever
 * the settings disagree with it, and again when they change during the session.
 * Sessions list later still, so the sidebar's list is cached per project the
 * same way and refreshed whenever the sidebar reloads it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { WorkbenchShell, type WorkbenchShellOptions } from "@oh-my-pi/pi-tui/fork/workbench/shell";
import type { SidebarSession } from "@oh-my-pi/pi-tui/fork/workbench/sidebar";
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
/** Sessions cached per project: enough to fill a tall terminal. */
const CACHED_SESSIONS = 100;
/** The session this launch will open, unknown before it exists: shown as a new one, the usual case. */
const STARTUP_SESSION_PATH = "\0startup";
/** The JSON last read or written per project, so an unchanged reload writes nothing. */
const knownSessions = new Map<string, string>();

interface CachedSessions {
	readonly cwd: string;
	readonly sessions: readonly { path: string; displayName: string; title?: string; modified: number }[];
}

function startupCachePath(): string {
	return path.join(path.dirname(getComposerCacheDbPath()), "workbench.json");
}

function sessionsCachePath(cwd: string): string {
	return path.join(path.dirname(getComposerCacheDbPath()), "workbench-sessions", `${Bun.hash(cwd).toString(36)}.json`);
}

function isCachedSessions(value: unknown, cwd: string): value is CachedSessions {
	if (typeof value !== "object" || value === null || !("cwd" in value) || value.cwd !== cwd) return false;
	if (!("sessions" in value) || !Array.isArray(value.sessions)) return false;
	return value.sessions.every(
		(s: unknown) =>
			typeof s === "object" &&
			s !== null &&
			"path" in s &&
			typeof s.path === "string" &&
			"displayName" in s &&
			typeof s.displayName === "string" &&
			"modified" in s &&
			typeof s.modified === "number",
	);
}

/** The sidebar list cached for `cwd`; undefined without one (and always under the test runner). */
function readStartupSessions(cwd: string): SidebarSession[] | undefined {
	if (isBunTestRuntime()) return undefined;
	try {
		const json = fs.readFileSync(sessionsCachePath(cwd), "utf8");
		const cached: unknown = JSON.parse(json);
		if (!isCachedSessions(cached, cwd)) return undefined;
		knownSessions.set(cwd, json);
		return cached.sessions.map(s => ({
			path: s.path,
			id: "",
			cwd,
			title: s.title,
			modified: new Date(s.modified),
			size: 0,
			firstMessage: "",
			allMessagesText: "",
			displayName: s.displayName,
		}));
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Workbench session cache unreadable", { error: String(err) });
		return undefined;
	}
}

/** Record the sidebar list for the next prepaint in `cwd`; writes only when it changed. */
export function rememberStartupSessions(cwd: string, sessions: readonly SidebarSession[]): void {
	if (isBunTestRuntime()) return;
	const newest = sessions.toSorted((a, b) => b.modified.getTime() - a.modified.getTime()).slice(0, CACHED_SESSIONS);
	const cached: CachedSessions = {
		cwd,
		sessions: newest.map(s => ({
			path: s.path,
			displayName: s.displayName,
			title: s.title,
			modified: s.modified.getTime(),
		})),
	};
	const json = JSON.stringify(cached);
	if (knownSessions.get(cwd) === json) return;
	knownSessions.set(cwd, json);
	Bun.write(sessionsCachePath(cwd), json).catch(err =>
		logger.warn("Workbench failed to cache its session list", { error: String(err) }),
	);
}

/**
 * The prepaint sidebar: the cached list (or "loading") until `installWorkbench`
 * hands over the live one, so the layout does not shift when the session lands.
 */
function startupSidebar(cwd: string): WorkbenchShellOptions {
	const sessions = readStartupSessions(cwd);
	return {
		sidebar: {
			// Nothing newer to list before the session exists.
			listSessions: () => (sessions ? Promise.resolve(sessions) : Promise.withResolvers<SidebarSession[]>().promise),
			projectName: () => path.basename(cwd),
			currentPath: () => STARTUP_SESSION_PATH,
			isStreaming: () => false,
			// No session to switch from yet; the live sidebar takes clicks a moment later.
			switchTo: async () => {},
			newSession: async () => {},
		},
		sidebarSessions: sessions,
	};
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
export function openStartupWorkbench(composer: Composer, cwd: string): void {
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
		const shell = new WorkbenchShell(host, startupSidebar(cwd));
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
