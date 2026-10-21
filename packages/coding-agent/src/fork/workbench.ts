/**
 * Fork-only wiring for the fullscreen workbench (custom branch). The shell
 * lives in pi-tui and depends on nothing here; this module hands it the
 * interactive mode and the app-level services it needs.
 */
import * as path from "node:path";
import { type Component, getKeybindings, isNativeRendering } from "@oh-my-pi/pi-tui";
import type { AppKeybinding } from "@oh-my-pi/pi-tui/app-keybindings";
import { type WorkbenchHost, WorkbenchShell } from "@oh-my-pi/pi-tui/fork/workbench/shell";
import type { SidebarDeps } from "@oh-my-pi/pi-tui/fork/workbench/sidebar";
import { ApprovalDialogComponent } from "@oh-my-pi/pi-tui/overlays/approval-dialog";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import type { ScopeLike } from "../config/registry";
import type { AgentSession } from "../session/agent-session";
import { sessionDisplayName } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { copyToClipboard } from "../utils/clipboard";
import { cfgWorkbenchEnabled, cfgWorkbenchStartsOpen } from "./workbench-settings";
import {
	discardStartupWorkbench,
	rememberStartupOpen,
	rememberStartupSessions,
	takeStartupWorkbench,
} from "./workbench-startup";

/** The InteractiveMode surface the workbench needs. */
export interface WorkbenchMode extends WorkbenchHost {
	readonly editor: Component;
	readonly settings: ScopeLike;
	readonly session: Pick<AgentSession, "isStreaming" | "subscribe">;
	readonly sessionManager: Pick<
		SessionManager,
		"getCwd" | "getSessionDir" | "getSessionFile" | "onSessionNameChanged"
	>;
	handleResumeSession(sessionPath: string): Promise<void>;
	handleNewCommand(): Promise<void>;
	showWarning(message: string): void;
	showError(message: string): void;
	toggleThinkingBlockVisibility(): void;
	showHistorySearch(): void;
	openExternalEditor(): void;
	resetDisplayAfterAppearanceRefresh(): void;
	toggleToolOutputExpansion(): void;
}

/**
 * Transcript-wide actions upstream binds through input listeners that stand
 * down whenever any overlay is visible. The shell is a permanent overlay, so
 * they are re-dispatched here while the prompt editor has the keys.
 */
const TRANSCRIPT_ACTIONS: readonly [AppKeybinding, (mode: WorkbenchMode) => void][] = [
	["app.thinking.toggle", mode => mode.toggleThinkingBlockVisibility()],
	["app.history.search", mode => mode.showHistorySearch()],
	["app.editor.external", mode => mode.openExternalEditor()],
	["app.display.reset", mode => mode.resetDisplayAfterAppearanceRefresh()],
	["app.tools.expand", mode => mode.toggleToolOutputExpansion()],
];

/** Upstream's `app.tools.expand` first expands a truncated ask question or approval prompt in place. */
function expandFocusedDialog(focused: Component | null): boolean {
	if (focused instanceof AskDialogComponent) return focused.toggleQuestionExpansion();
	if (focused instanceof ApprovalDialogComponent) return focused.toggleDetails();
	return false;
}

/** Show a failed switch like upstream's session selector does, then let the sidebar see it fail too. */
async function reportingErrors(mode: WorkbenchMode, action: () => Promise<void>): Promise<void> {
	try {
		await action();
	} catch (error) {
		mode.showError(error instanceof Error ? error.message : String(error));
		throw error;
	}
}

/** The sidebar's view of this project's sessions; read live, so `/move` and worktree moves follow. */
function sidebarDeps(mode: WorkbenchMode): SidebarDeps {
	return {
		async listSessions() {
			const manager = mode.sessionManager;
			const cwd = manager.getCwd();
			const infos = await SessionManager.listForPicker(cwd, manager.getSessionDir());
			const sessions = infos.map(info => ({ ...info, displayName: sessionDisplayName(info) }));
			rememberStartupSessions(cwd, sessions);
			return sessions;
		},
		projectName: () => path.basename(mode.sessionManager.getCwd()),
		currentPath: () => mode.sessionManager.getSessionFile(),
		isStreaming: () => mode.session.isStreaming,
		switchTo: sessionPath => reportingErrors(mode, () => mode.handleResumeSession(sessionPath)),
		newSession: () => reportingErrors(mode, () => mode.handleNewCommand()),
	};
}

/** The shell the startup prepaint opened, now hosted by `mode`; a new one when startup opened none. */
function takeOverShell(mode: WorkbenchMode): WorkbenchShell {
	const options = {
		notify: (message: string) => mode.showWarning(message),
		copyToClipboard,
		sidebar: sidebarDeps(mode),
	};
	const startup = takeStartupWorkbench(mode.ui);
	if (startup) {
		startup.rebind(mode, options);
		return startup;
	}
	const shell = new WorkbenchShell(mode, options);
	shell.install();
	return shell;
}

/**
 * Install the workbench on a fully initialized interactive mode and, with
 * `autoOpen`, open it; the toggle still hides it. Disabled, nothing is
 * installed (a shell the prepaint opened from a stale cache is removed).
 */
export function installWorkbench(mode: WorkbenchMode): WorkbenchShell | undefined {
	const autoOpen = cfgWorkbenchStartsOpen.get(mode.settings);
	rememberStartupOpen(autoOpen);
	// A change in /settings applies next launch; caching it now keeps that launch's prepaint right.
	cfgWorkbenchStartsOpen.listen(mode.settings, open => rememberStartupOpen(open));
	if (!cfgWorkbenchEnabled.get(mode.settings)) {
		discardStartupWorkbench(mode.ui);
		return undefined;
	}
	const shell = takeOverShell(mode);
	// Native rendering cannot host the shell; stay inline there without the warning open() would show.
	if (!autoOpen) shell.close();
	else if (!isNativeRendering()) shell.open();
	// A finished turn may have titled its session; titles generated after it, and /rename, report here.
	mode.session.subscribe(event => {
		if (event.type === "agent_end") shell.refreshSessions();
	});
	mode.sessionManager.onSessionNameChanged(() => shell.refreshSessions());
	// Registered after upstream's listeners, so it only sees keys they passed on.
	mode.ui.addInputListener(data => {
		if (!shell.isFrontmost) return undefined;
		const keybindings = getKeybindings();
		const focused = mode.ui.getFocused();
		const onDialog = focused instanceof AskDialogComponent || focused instanceof ApprovalDialogComponent;
		if (onDialog && keybindings.matches(data, "app.tools.expand")) {
			// Like upstream: nothing to expand in the dialog itself → expand the transcript's tool output.
			if (!expandFocusedDialog(focused)) mode.toggleToolOutputExpansion();
			return { consume: true };
		}
		if (focused !== mode.editor) return undefined;
		const action = TRANSCRIPT_ACTIONS.find(([id]) => keybindings.matches(data, id));
		if (!action) return undefined;
		action[1](mode);
		return { consume: true };
	});
	return shell;
}
