import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { type Component, Container, getKeybindings, setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Settings } from "../src/config/settings";
import { installWorkbench, type WorkbenchMode } from "../src/fork/workbench";
import { cfgWorkbenchAutoOpen } from "../src/fork/workbench-settings";
import * as workbenchStartup from "../src/fork/workbench-startup";
import type { SessionInfo } from "../src/session/session-listing";
import { SessionManager } from "../src/session/session-manager";
import {
	beginStartupComposer,
	stopPendingStartupComposer,
	takeStartupComposerLease,
} from "../src/modes/startup-composer";
import { withoutTerminalMultiplexer } from "../../tui/test/helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

withoutTerminalMultiplexer();

const CTRL_N = "\x0e";
const CTRL_O = "\x0f";
const CTRL_T = "\x14";

class Editor implements Component {
	focused = false;
	typed = "";

	handleInput(data: string): void {
		this.typed += data;
	}

	render(): string[] {
		return ["> draft"];
	}
}

const cleanups: (() => void)[] = [];
let previousKeybindings: KeybindingsManager | undefined;

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	if (previousKeybindings) setKeybindings(previousKeybindings);
	previousKeybindings = undefined;
	vi.restoreAllMocks();
});

function useAppKeybindings(): void {
	previousKeybindings = getKeybindings() as KeybindingsManager;
	setKeybindings(KeybindingsManager.inMemory());
}

/** The InteractiveMode stand-in: transcript and editor area mounted, actions recorded. */
function mountMode(composer: Composer, editor: Component, settings = Settings.isolated()) {
	const chatContainer = new TranscriptContainer();
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	composer.setRuntimeChildren([chatContainer, editorContainer], { transientChrome: [editorContainer] });
	const calls: string[] = [];
	const nameListeners: (() => void)[] = [];
	const mode: WorkbenchMode = {
		ui: composer.ui,
		chatContainer,
		editorContainer,
		editor,
		settings,
		showWarning: message => calls.push(`warning: ${message}`),
		showError: message => calls.push(`error: ${message}`),
		toggleThinkingBlockVisibility: () => calls.push("thinking"),
		showHistorySearch: () => calls.push("history"),
		openExternalEditor: () => calls.push("external"),
		resetDisplayAfterAppearanceRefresh: () => calls.push("reset"),
		toggleToolOutputExpansion: () => calls.push("expand"),
		// Below the sidebar's auto width (100 columns) the session list is never loaded.
		session: { isStreaming: false, subscribe: () => () => {} },
		sessionManager: {
			getCwd: () => "/project",
			getSessionDir: () => "/sessions",
			getSessionFile: () => "/sessions/current.jsonl",
			onSessionNameChanged: listener => {
				nameListeners.push(listener);
				return () => {};
			},
		},
		handleResumeSession: async path => {
			calls.push(`resume: ${path}`);
		},
		handleNewCommand: async () => {
			calls.push("new");
		},
	};
	const renameSession = () => {
		for (const listener of nameListeners) listener();
	};
	return { mode, chatContainer, calls, renameSession };
}

function harness(columns = 60, configure?: (mode: WorkbenchMode) => void, settings?: Settings) {
	useAppKeybindings();
	const terminal = new VirtualTerminal(columns, 12);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	cleanups.push(() => composer.stop());
	const editor = new Editor();
	const { mode, calls, renameSession } = mountMode(composer, editor, settings);
	configure?.(mode);
	composer.start({ playWelcomeIntro: false });
	composer.ui.setFocus(editor);
	const shell = installWorkbench(mode);
	cleanups.push(() => shell?.close());
	const settle = async () => {
		// Let a session list load resolve, then paint what it requested.
		await scheduler.settle(terminal);
		await Bun.sleep(0);
		await scheduler.settle(terminal);
	};
	const press = async (data: string) => {
		terminal.sendInput(data);
		await settle();
	};
	return { terminal, composer, editor, shell, calls, press, settle, renameSession };
}

function sessionInfo(name: string, minutesAgo: number): SessionInfo {
	const modified = new Date(Date.now() - minutesAgo * 60_000);
	return {
		path: `/sessions/${name}.jsonl`,
		id: name,
		cwd: "/project",
		title: name,
		created: modified,
		modified,
		messageCount: 2,
		size: 1,
		firstMessage: name,
		allMessagesText: name,
	};
}

function rowOf(terminal: VirtualTerminal, text: string): number {
	return terminal.getViewport().findIndex(row => Bun.stripANSI(row).includes(text));
}

describe("workbench transcript actions", () => {
	it("opens on install and runs the actions upstream stands down for while the shell is frontmost", async () => {
		const h = harness();
		expect(h.shell?.isOpen).toBe(true);

		await h.press(CTRL_O);
		await h.press(CTRL_T);
		expect(h.calls).toEqual(["expand", "thinking"]);
		expect(h.editor.typed).toBe("");
	});

	it("stays inline without a warning when native rendering is on at startup", () => {
		setNativeRendering(true);
		cleanups.push(() => setNativeRendering(false));
		const h = harness();
		expect(h.shell?.isOpen).toBe(false);
		expect(h.calls).toEqual([]);
	});

	it("leaves the keys alone when the shell is closed or covered", async () => {
		const h = harness();
		await h.press(CTRL_N);
		expect(h.shell?.isOpen).toBe(false);
		await h.press(CTRL_O);
		expect(h.calls).toEqual([]);
		expect(h.editor.typed).toBe(CTRL_O);

		await h.press(CTRL_N);
		const picker: Component = { render: () => ["picker"], handleInput: () => {} };
		h.composer.ui.showOverlay(picker, { fullscreen: true });
		await h.press(CTRL_O);
		expect(h.calls).toEqual([]);
	});
});

/** Records the raw bytes the TUI writes, to check what reached the terminal before the alt screen. */
class CapturingTerminal extends VirtualTerminal {
	#raw = "";

	override write(data: string): void {
		this.#raw += data;
		super.write(data);
	}

	get raw(): string {
		return this.#raw;
	}
}

const ALT_SCREEN_ENTER = "\x1b[?1049h";
const MOUSE_ANY_MOTION_ON = "\x1b[?1003h";

describe("workbench at startup", () => {
	afterEach(() => stopPendingStartupComposer());

	it("paints the prepaint frame fullscreen, reports the mouse once input is raw, and the interactive mode takes that shell over", async () => {
		useAppKeybindings();
		const terminal = new CapturingTerminal(60, 12);
		beginStartupComposer({ terminal, version: "9.9.9", cache: false, preferences: { quiet: true } });
		await terminal.waitForRender();
		// The first frame is the shell: nothing was painted inline before the alt screen.
		const altAt = terminal.raw.indexOf(ALT_SCREEN_ENTER);
		expect(altAt).toBeGreaterThanOrEqual(0);
		expect(Bun.stripANSI(terminal.raw.slice(0, altAt)).trim()).toBe("");
		// The prompt box is pinned to the bottom, not right under the header.
		expect(rowOf(terminal, "╰")).toBeGreaterThanOrEqual(terminal.rows - 4);
		// Input is still deferred (cooked tty), where reports would echo onto the frame.
		expect(terminal.raw).not.toContain(MOUSE_ANY_MOTION_ON);

		const lease = takeStartupComposerLease()!;
		cleanups.push(() => lease.composer.stop());
		lease.adopt();
		await terminal.waitForRender();
		// Raw input arrived before the session: the wheel scrolls instead of sending arrow keys.
		expect(terminal.raw).toContain(MOUSE_ANY_MOTION_ON);
		const { mode, chatContainer } = mountMode(lease.composer, lease.composer.editor);
		chatContainer.addChild({ render: () => ["answer 0"] });
		const shell = installWorkbench(mode);
		cleanups.push(() => shell?.close());
		terminal.sendInput("hello");
		await terminal.waitForRender();
		// One shell, now showing the transcript; a second one would stay stacked after the toggle.
		expect(lease.composer.ui.overlayStack).toHaveLength(1);
		expect(rowOf(terminal, "answer 0")).toBe(0);
		expect(rowOf(terminal, "hello")).toBeGreaterThanOrEqual(terminal.rows - 4);
		terminal.sendInput(CTRL_N);
		await terminal.waitForRender();
		expect(lease.composer.ui.hasOverlay()).toBe(false);
	});
});

describe("workbench settings", () => {
	afterEach(() => stopPendingStartupComposer());

	it("with the workbench disabled installs nothing and leaves its keys to the editor", async () => {
		const h = harness(60, undefined, Settings.isolated({ "fork.workbench.enabled": false }));
		expect(h.shell).toBeUndefined();
		expect(h.composer.ui.hasOverlay()).toBe(false);
		await h.press(CTRL_N);
		expect(h.composer.ui.hasOverlay()).toBe(false);
		expect(h.editor.typed).toBe(CTRL_N);
	});

	it("with autoOpen off stays inline until the toggle opens it", async () => {
		const h = harness(60, undefined, Settings.isolated({ "fork.workbench.autoOpen": false }));
		expect(h.shell?.isOpen).toBe(false);
		await h.press(CTRL_N);
		expect(h.shell?.isOpen).toBe(true);
	});

	it("records a /settings change for the next launch's prepaint", async () => {
		const remembered = spyOn(workbenchStartup, "rememberStartupOpen");
		const settings = Settings.isolated();
		harness(60, undefined, settings);
		expect(remembered).toHaveBeenLastCalledWith(true);
		cfgWorkbenchAutoOpen.set(settings, false);
		await Bun.sleep(0);
		expect(remembered).toHaveBeenLastCalledWith(false);
	});

	it("closes the shell a stale cache opened at prepaint, then reopens it over the session", async () => {
		useAppKeybindings();
		const terminal = new CapturingTerminal(60, 12);
		beginStartupComposer({ terminal, version: "9.9.9", cache: false, preferences: { quiet: true } });
		await terminal.waitForRender();
		const lease = takeStartupComposerLease()!;
		cleanups.push(() => lease.composer.stop());
		lease.adopt();
		expect(lease.composer.ui.hasOverlay()).toBe(true);

		const settings = Settings.isolated({ "fork.workbench.autoOpen": false });
		const { mode, chatContainer } = mountMode(lease.composer, lease.composer.editor, settings);
		chatContainer.addChild({ render: () => ["answer 0"] });
		const shell = installWorkbench(mode);
		cleanups.push(() => shell?.close());
		expect(lease.composer.ui.hasOverlay()).toBe(false);
		// The toggle reopens it hosted by the session: the transcript is inside.
		terminal.sendInput(CTRL_N);
		await terminal.waitForRender();
		expect(lease.composer.ui.overlayStack).toHaveLength(1);
		expect(rowOf(terminal, "answer 0")).toBe(0);
	});

	it("removes the shell the prepaint opened when the settings turned the workbench off", async () => {
		useAppKeybindings();
		const terminal = new CapturingTerminal(60, 12);
		beginStartupComposer({ terminal, version: "9.9.9", cache: false, preferences: { quiet: true } });
		await terminal.waitForRender();
		const lease = takeStartupComposerLease()!;
		cleanups.push(() => lease.composer.stop());
		lease.adopt();
		expect(lease.composer.ui.hasOverlay()).toBe(true);

		const settings = Settings.isolated({ "fork.workbench.enabled": false });
		const { mode } = mountMode(lease.composer, lease.composer.editor, settings);
		expect(installWorkbench(mode)).toBeUndefined();
		expect(lease.composer.ui.hasOverlay()).toBe(false);
		// Its input routing went with it: the toggle no longer reopens it.
		terminal.sendInput(CTRL_N);
		await terminal.waitForRender();
		expect(lease.composer.ui.hasOverlay()).toBe(false);
	});
});

describe("workbench session sidebar", () => {
	it("lists the project's sessions, reloads them on a rename and shows a failed switch", async () => {
		const listed = spyOn(SessionManager, "listForPicker").mockResolvedValue([
			sessionInfo("current", 1),
			sessionInfo("broken", 2),
		]);
		const h = harness(120, mode => {
			mode.handleResumeSession = async () => {
				throw new Error("session file is corrupt");
			};
		});
		await h.settle();
		expect(listed).toHaveBeenCalledWith("/project", "/sessions");
		const row = rowOf(h.terminal, "broken");
		expect(row).toBeGreaterThan(0);

		h.renameSession();
		await h.settle();
		expect(listed).toHaveBeenCalledTimes(2);

		await h.press(`\x1b[<0;3;${row + 1}M`);
		await h.press(`\x1b[<0;3;${row + 1}m`);
		expect(h.calls).toEqual(["error: session file is corrupt"]);
	});
});
