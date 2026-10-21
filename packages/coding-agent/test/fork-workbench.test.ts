import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type Component, Container, getKeybindings, setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { installWorkbench, type WorkbenchMode } from "../src/fork/workbench";
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

function harness() {
	previousKeybindings = getKeybindings() as KeybindingsManager;
	setKeybindings(KeybindingsManager.inMemory());
	const terminal = new VirtualTerminal(60, 12);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const chatContainer = new TranscriptContainer();
	const editor = new Editor();
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	composer.setRuntimeChildren([chatContainer, editorContainer], { transientChrome: [editorContainer] });
	composer.start({ playWelcomeIntro: false });
	composer.ui.setFocus(editor);
	cleanups.push(() => composer.stop());

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
	const shell = installWorkbench(mode);
	cleanups.push(() => shell.close());
	const press = async (data: string) => {
		terminal.sendInput(data);
		await scheduler.settle(terminal);
	};
	return { composer, editor, shell, calls, press };
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
