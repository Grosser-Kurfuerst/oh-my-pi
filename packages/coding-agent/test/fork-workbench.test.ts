import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type Component, Container, getKeybindings, setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { installWorkbench, type WorkbenchMode } from "../src/fork/workbench";
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
});

function useAppKeybindings(): void {
	previousKeybindings = getKeybindings() as KeybindingsManager;
	setKeybindings(KeybindingsManager.inMemory());
}

/** The InteractiveMode stand-in: transcript and editor area mounted, actions recorded. */
function mountMode(composer: Composer, editor: Component) {
	const chatContainer = new TranscriptContainer();
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	composer.setRuntimeChildren([chatContainer, editorContainer], { transientChrome: [editorContainer] });
	const calls: string[] = [];
	const mode: WorkbenchMode = {
		ui: composer.ui,
		chatContainer,
		editorContainer,
		editor,
		showWarning: message => calls.push(`warning: ${message}`),
		toggleThinkingBlockVisibility: () => calls.push("thinking"),
		showHistorySearch: () => calls.push("history"),
		openExternalEditor: () => calls.push("external"),
		resetDisplayAfterAppearanceRefresh: () => calls.push("reset"),
		toggleToolOutputExpansion: () => calls.push("expand"),
	};
	return { mode, chatContainer, calls };
}

function harness() {
	useAppKeybindings();
	const terminal = new VirtualTerminal(60, 12);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	cleanups.push(() => composer.stop());
	const editor = new Editor();
	const { mode, calls } = mountMode(composer, editor);
	composer.start({ playWelcomeIntro: false });
	composer.ui.setFocus(editor);
	const shell = installWorkbench(mode);
	cleanups.push(() => shell.close());
	const press = async (data: string) => {
		terminal.sendInput(data);
		await scheduler.settle(terminal);
	};
	return { composer, editor, shell, calls, press };
}

function rowOf(terminal: VirtualTerminal, text: string): number {
	return terminal.getViewport().findIndex(row => Bun.stripANSI(row).includes(text));
}

describe("workbench transcript actions", () => {
	it("opens on install and runs the actions upstream stands down for while the shell is frontmost", async () => {
		const h = harness();
		expect(h.shell.isOpen).toBe(true);

		await h.press(CTRL_O);
		await h.press(CTRL_T);
		expect(h.calls).toEqual(["expand", "thinking"]);
		expect(h.editor.typed).toBe("");
	});

	it("stays inline without a warning when native rendering is on at startup", () => {
		setNativeRendering(true);
		cleanups.push(() => setNativeRendering(false));
		const h = harness();
		expect(h.shell.isOpen).toBe(false);
		expect(h.calls).toEqual([]);
	});

	it("leaves the keys alone when the shell is closed or covered", async () => {
		const h = harness();
		await h.press(CTRL_N);
		expect(h.shell.isOpen).toBe(false);
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
		cleanups.push(() => shell.close());
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
