/**
 * Fork-only wiring for the fullscreen workbench (custom branch). The shell
 * lives in pi-tui and depends on nothing here; this module hands it the
 * interactive mode and the app-level services it needs.
 */
import { type Component, getKeybindings, isNativeRendering } from "@oh-my-pi/pi-tui";
import type { AppKeybinding } from "@oh-my-pi/pi-tui/app-keybindings";
import { type WorkbenchHost, WorkbenchShell } from "@oh-my-pi/pi-tui/fork/workbench/shell";
import { ApprovalDialogComponent } from "@oh-my-pi/pi-tui/overlays/approval-dialog";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { copyToClipboard } from "../utils/clipboard";

/** The InteractiveMode surface the workbench needs. */
export interface WorkbenchMode extends WorkbenchHost {
	readonly editor: Component;
	showWarning(message: string): void;
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

/** Install the workbench on a fully initialized interactive mode and open it; the toggle still hides it. */
export function installWorkbench(mode: WorkbenchMode): WorkbenchShell {
	const shell = new WorkbenchShell(mode, {
		notify: message => mode.showWarning(message),
		copyToClipboard,
	});
	shell.install();
	// Native rendering cannot host the shell; stay inline there without the warning open() would show.
	if (!isNativeRendering()) shell.open();
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
