import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { SkillMessageComponent } from "@oh-my-pi/pi-tui/chat/skill-message";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { clampBottomRows, computeLayout, regionAt } from "@oh-my-pi/pi-tui/fork/workbench/layout";
import { WorkbenchShell, type WorkbenchShellOptions } from "@oh-my-pi/pi-tui/fork/workbench/shell";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	type Focusable,
	getKeybindings,
	setKeybindings,
} from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const COLUMNS = 60;
const ROWS = 12;
const CTRL_N = "\x0e";

/** Stand-in for the prompt editor: a focusable row that hosts the hardware cursor. */
class CursorEditor implements Component, Focusable {
	focused = false;
	typed = "";

	setUseTerminalCursor(_enabled: boolean): void {}

	handleInput(data: string): void {
		this.typed += data;
	}

	render(): string[] {
		return [`> ${this.focused ? CURSOR_MARKER : ""}draft`];
	}
}

/** Plain one-row overlay used to stack other overlays above the shell. */
class Popup implements Component {
	constructor(readonly text: string) {}

	render(): string[] {
		return [this.text];
	}
}

function addRows(transcript: TranscriptContainer, prefix: string, count: number): void {
	for (let index = 0; index < count; index++) {
		const row = `${prefix} ${index}`;
		transcript.addChild({ render: () => [row] });
	}
}

function plain(rows: readonly string[]): string[] {
	// The turn rail is the last cell of a content row.
	return rows.map(row =>
		Bun.stripANSI(row)
			.replace(/[│┃━]$/, "")
			.trimEnd(),
	);
}

/** Native scrollback only: the scroll buffer minus the active grid (alt or normal). */
function nativeHistory(terminal: VirtualTerminal): string[] {
	return plain(terminal.getScrollBuffer().slice(0, -terminal.rows));
}

function harness(options?: WorkbenchShellOptions) {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	const editor = new CursorEditor();
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	composer.setRuntimeChildren([transcript, editorContainer], { transientChrome: [editorContainer] });
	composer.start({ playWelcomeIntro: false });
	composer.ui.setFocus(editor);
	// Mutable like InteractiveMode: a session rebuild repoints chatContainer at a staged container.
	const host = { ui: composer.ui, chatContainer: transcript, editorContainer };
	const shell = new WorkbenchShell(host, options);
	const uninstall = shell.install();
	const settle = () => scheduler.settle(terminal);
	cleanups.push(() => {
		uninstall();
		composer.stop();
	});
	return { terminal, composer, transcript, editor, editorContainer, host, shell, settle };
}

let previousKeybindings: KeybindingsManager | undefined;
const cleanups: (() => void)[] = [];

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

describe("workbench shell", () => {
	it("freezes native history while open and catches every row up once on close", async () => {
		useAppKeybindings();
		const h = harness();
		addRows(h.transcript, "before", 20);
		await h.settle();

		h.terminal.sendInput(CTRL_N);
		await h.settle();
		expect(h.shell.isOpen).toBe(true);
		const frozen = nativeHistory(h.terminal);
		expect(frozen).toContain("before 0");

		addRows(h.transcript, "during", 30);
		h.composer.ui.requestRender();
		await h.settle();
		// Nothing reaches native scrollback while the shell owns the alt screen…
		expect(nativeHistory(h.terminal)).toEqual(frozen);
		// …but the shell itself follows the growing transcript.
		expect(plain(h.terminal.getViewport())).toContain("during 29");

		h.terminal.sendInput(CTRL_N);
		await h.settle();
		expect(h.shell.isOpen).toBe(false);
		const buffer = plain(h.terminal.getScrollBuffer());
		for (const prefix of ["before", "during"]) {
			const count = prefix === "before" ? 20 : 30;
			for (let index = 0; index < count; index++) {
				expect(buffer.filter(row => row === `${prefix} ${index}`)).toHaveLength(1);
			}
		}
	});

	it("keeps the hardware cursor on the editor row of the pinned bottom area", async () => {
		const h = harness();
		addRows(h.transcript, "row", 30);
		await h.settle();
		h.shell.open();
		await h.settle();

		expect(h.composer.ui.getFocused()).toBe(h.editor);
		const viewport = plain(h.terminal.getViewport());
		const cursor = h.terminal.getCursor();
		expect(viewport[cursor.row]).toBe("> draft");
		expect(cursor.col).toBe(2);
		// The editor is pinned below the scrolled transcript, not interleaved with it.
		expect(viewport.slice(0, cursor.row).at(-1)).toBe("row 29");
	});

	it("hands keys back to the editor when a fullscreen overlay above it closes", async () => {
		const h = harness();
		await h.settle();
		h.shell.open();
		await h.settle();

		const picker = h.composer.ui.showOverlay(new Popup("picker"), { fullscreen: true });
		await h.settle();
		picker.hide();
		await h.settle();

		h.terminal.sendInput("x");
		await h.settle();
		expect(h.editor.typed).toBe("x");
		expect(h.composer.ui.getFocused()).toBe(h.editor);
	});

	it("steps aside for an inline popup and returns once it closes", async () => {
		useAppKeybindings();
		const h = harness();
		addRows(h.transcript, "row", 5);
		await h.settle();
		h.shell.open();
		await h.settle();

		const popup = h.composer.ui.showOverlay(new Popup("inline popup"));
		await h.settle();
		await Bun.sleep(0);
		await h.settle();
		// The normal screen is back: the transcript shows under the popup instead of a fullscreen frame.
		const underPopup = plain(h.terminal.getViewport());
		expect(underPopup.some(row => row.includes("inline popup"))).toBe(true);
		expect(underPopup).toContain("row 4");
		expect(underPopup.filter(row => row === "> draft")).toHaveLength(1);

		popup.hide();
		await Bun.sleep(400);
		await h.settle();
		// Back in the fullscreen frame: the editor is pinned to the last screen row again.
		const resumed = plain(h.terminal.getViewport());
		expect(resumed.some(row => row.includes("inline popup"))).toBe(false);
		expect(resumed.at(-1)).toBe("> draft");
		expect(
			resumed
				.slice(0, -1)
				.filter(row => row !== "")
				.at(-1),
		).toBe("row 4");
		expect(h.composer.ui.getFocused()).toBe(h.editor);
		// The toggle reaches the shell only when it is the frontmost overlay again.
		h.terminal.sendInput(CTRL_N);
		await h.settle();
		expect(h.shell.isOpen).toBe(false);
	});

	it("stops following on wheel-up and reports the rows below the viewport", async () => {
		const h = harness();
		addRows(h.transcript, "row", 40);
		await h.settle();
		h.shell.open();
		await h.settle();

		h.terminal.sendInput("\x1b[<64;5;3M");
		await h.settle();
		const scrolled = plain(h.terminal.getViewport());
		expect(scrolled).not.toContain("row 39");
		expect(scrolled.some(row => row.startsWith("↓ 下方还有"))).toBe(true);
		// The wheel report is consumed by the shell, never typed into the editor.
		expect(h.editor.typed).toBe("");

		addRows(h.transcript, "late", 1);
		h.composer.ui.requestRender();
		await h.settle();
		expect(plain(h.terminal.getViewport())).not.toContain("late 0");
	});

	it("scrolls back to the bottom and follows again when the rows-below hint is clicked", async () => {
		const copied: string[] = [];
		const h = harness({
			copyToClipboard: async text => {
				copied.push(text);
			},
		});
		addRows(h.transcript, "row", 40);
		await h.settle();
		h.shell.open();
		await h.settle();
		h.terminal.sendInput("\x1b[<64;5;3M");
		await h.settle();
		const hintRow = plain(h.terminal.getViewport()).findIndex(row => row.startsWith("↓ 下方还有"));
		expect(hintRow).toBeGreaterThan(-1);

		h.terminal.sendInput(mouse("press", 4, hintRow));
		h.terminal.sendInput(mouse("release", 4, hintRow));
		await h.settle();
		const bottom = plain(h.terminal.getViewport());
		expect(bottom).toContain("row 39");
		expect(bottom.some(row => row.startsWith("↓ 下方还有"))).toBe(false);
		// Back at the tail, new output is followed again.
		addRows(h.transcript, "late", 1);
		h.composer.ui.requestRender();
		await h.settle();
		// With the hint gone, its row is content again: a double click there selects a word.
		const last = rowOf(h.terminal, "late 0");
		expect(last).toBe(hintRow);
		for (let click = 0; click < 2; click++) {
			h.terminal.sendInput(mouse("press", 1, last));
			h.terminal.sendInput(mouse("release", 1, last));
		}
		await h.settle();
		expect(copied).toEqual(["late"]);
	});

	it("drops the replaced session from native history when a clear lands while open", async () => {
		const h = harness();
		addRows(h.transcript, "old", 20);
		await h.settle();
		expect(nativeHistory(h.terminal)).toContain("old 0");
		h.shell.open();
		await h.settle();

		// Session replacement: the transcript is rebuilt and a destructive repaint requested.
		h.transcript.clear();
		addRows(h.transcript, "new", 20);
		h.composer.ui.requestRender(true, { clearScrollback: true });
		await h.settle();
		h.shell.close();
		await h.settle();

		const buffer = plain(h.terminal.getScrollBuffer());
		expect(buffer.some(row => row.startsWith("old "))).toBe(false);
		for (let index = 0; index < 20; index++) {
			expect(buffer.filter(row => row === `new ${index}`)).toHaveLength(1);
		}
	});

	it("keeps a dialog that took the editor slot behind an inline popup focused when the shell returns", async () => {
		const h = harness();
		await h.settle();
		h.shell.open();
		await h.settle();

		const popup = h.composer.ui.showOverlay(new Popup("inline popup"));
		await h.settle();
		await Bun.sleep(0);
		// An ask dialog replaces the editor while the popup is up…
		const dialog = new CursorEditor();
		h.editorContainer.clear();
		h.editorContainer.addChild(dialog);
		// …and the popup's owner focuses the active editor area as it closes.
		popup.hide();
		h.composer.ui.setFocus(dialog);
		await Bun.sleep(400);
		await h.settle();

		expect(h.composer.ui.getFocused()).toBe(dialog);
		h.terminal.sendInput("y");
		await h.settle();
		expect(dialog.typed).toBe("y");
		expect(h.editor.typed).toBe("");
	});

	it("keeps the mounted transcript in the content area while a session rebuild stages another one", async () => {
		const h = harness();
		addRows(h.transcript, "row", 30);
		await h.settle();
		h.shell.open();
		await h.settle();

		h.host.chatContainer = new TranscriptContainer();
		h.composer.ui.requestRender();
		await h.settle();
		expect(plain(h.terminal.getViewport())).toContain("row 29");
		// Still a scrollable content area above a pinned editor, not one flattened stack.
		h.terminal.sendInput("\x1b[<64;5;3M");
		await h.settle();
		const scrolled = plain(h.terminal.getViewport());
		expect(scrolled).not.toContain("row 29");
		expect(scrolled.at(-1)).toBe("> draft");
	});
});

const CTRL_UP = "\x1b[1;5A";
const CTRL_DOWN = "\x1b[1;5B";
/** 0-based screen column of the rail cell. */
const RAIL_COL = COLUMNS - 1;

/** SGR mouse report at a 0-based cell: left press/release, motion with no button or the left one held. */
function mouse(kind: "press" | "move" | "drag" | "release", col: number, row: number): string {
	const button = { press: 0, move: 35, drag: 32, release: 0 }[kind];
	return `\x1b[<${button};${col + 1};${row + 1}${kind === "release" ? "m" : "M"}`;
}

/**
 * Three user turns as the live transcript shows them: a prompt the model
 * reacted to, a `/skill:` prompt, and a steered prompt, each followed by an
 * answer; a synthetic auto-continue bubble in between is not a turn.
 */
function addConversation(transcript: TranscriptContainer): void {
	const first = new UserMessageComponent("first prompt");
	first.setReaction("👍");
	transcript.addChild(first);
	addRows(transcript, "answer-a", 12);
	transcript.addChild(new UserMessageComponent("continue", { synthetic: true }));
	transcript.addChild(
		new SkillMessageComponent({
			role: "custom",
			customType: "skill-prompt",
			content: "Loaded SKILL.md instructions",
			display: true,
			attribution: "user",
			timestamp: 1,
			details: { name: "review", path: "/tmp/SKILL.md", lineCount: 3, prompt: "/skill:review the diff" },
		}),
	);
	addRows(transcript, "answer-s", 12);
	transcript.addChild(new UserMessageComponent("second prompt", { liveSteered: true }));
	addRows(transcript, "answer-b", 20);
}

/** Viewport row showing `text`, or -1. */
function rowOf(terminal: VirtualTerminal, text: string): number {
	return plain(terminal.getViewport()).findIndex(row => row.includes(text));
}

function railTicks(terminal: VirtualTerminal): number {
	return Bun.stripANSI(terminal.getViewport().join("\n"))
		.split("\n")
		.filter(row => row.endsWith("━")).length;
}

describe("workbench turns", () => {
	it("marks each real prompt on the rail and jumps between them without overshooting", async () => {
		useAppKeybindings();
		const h = harness();
		addConversation(h.transcript);
		h.shell.open();
		await h.settle();
		// The synthetic bubble is not a turn.
		expect(railTicks(h.terminal)).toBe(3);
		expect(rowOf(h.terminal, "answer-b 19")).toBeGreaterThan(-1);

		const press = async (data: string) => {
			h.terminal.sendInput(data);
			await h.settle();
		};
		// From the tail, back lands on the latest prompt near the top of the viewport…
		await press(CTRL_UP);
		const second = rowOf(h.terminal, "second prompt");
		expect(second).toBeGreaterThanOrEqual(0);
		expect(second).toBeLessThanOrEqual(2);
		// …then on the skill prompt, then on the first, and stays there.
		await press(CTRL_UP);
		expect(rowOf(h.terminal, "review")).toBeLessThanOrEqual(2);
		await press(CTRL_UP);
		const first = rowOf(h.terminal, "first prompt");
		expect(first).toBeGreaterThanOrEqual(0);
		expect(first).toBeLessThanOrEqual(2);
		await press(CTRL_UP);
		expect(rowOf(h.terminal, "first prompt")).toBe(first);
		// Forward past the last prompt reaches the end of its answer.
		await press(CTRL_DOWN);
		await press(CTRL_DOWN);
		expect(rowOf(h.terminal, "second prompt")).toBe(second);
		await press(CTRL_DOWN);
		expect(rowOf(h.terminal, "answer-b 19")).toBeGreaterThan(-1);
		expect(h.editor.typed).toBe("");
	});

	it("opens a hidden shell on the latest prompt, and keys keep typing into the prompt", async () => {
		useAppKeybindings();
		const h = harness();
		addConversation(h.transcript);
		await h.settle();
		expect(rowOf(h.terminal, "second prompt")).toBe(-1);
		h.terminal.sendInput(CTRL_UP);
		await h.settle();
		expect(h.shell.isOpen).toBe(true);
		const second = rowOf(h.terminal, "second prompt");
		expect(second).toBeGreaterThanOrEqual(0);
		expect(second).toBeLessThanOrEqual(2);

		h.terminal.sendInput("x");
		await h.settle();
		expect(h.editor.typed).toBe("x");
	});

	it("names the hovered tick and jumps to it on click", async () => {
		useAppKeybindings();
		const h = harness();
		addConversation(h.transcript);
		h.shell.open();
		await h.settle();
		expect(rowOf(h.terminal, "first prompt")).toBe(-1);

		h.terminal.sendInput(mouse("move", RAIL_COL, 0));
		await h.settle();
		// Named by the prompt text, not the reaction badge on the bubble's top row.
		expect(rowOf(h.terminal, "第 1/3 轮 · first prompt")).toBeGreaterThan(-1);
		h.terminal.sendInput(mouse("press", RAIL_COL, 0));
		await h.settle();
		expect(rowOf(h.terminal, "first prompt")).toBeLessThanOrEqual(1);
		// Leaving the rail clears the hint.
		h.terminal.sendInput(mouse("move", 0, 3));
		await h.settle();
		expect(rowOf(h.terminal, "第 1/3 轮")).toBe(-1);
		expect(h.editor.typed).toBe("");
	});

	it("keeps the viewport on the same prompt when a resize reflows the answer above it", async () => {
		useAppKeybindings();
		const h = harness();
		h.transcript.addChild(new UserMessageComponent("first prompt"));
		// Each block wraps to two rows once the content column is narrower than 50.
		for (let index = 0; index < 20; index++) {
			h.transcript.addChild({
				render: (width: number) => (width < 50 ? [`wrap ${index}`, `wrap ${index}…`] : [`wrap ${index}`]),
			});
		}
		h.transcript.addChild(new UserMessageComponent("second prompt"));
		addRows(h.transcript, "answer-b", 20);
		h.shell.open();
		await h.settle();
		h.terminal.sendInput(CTRL_UP);
		await h.settle();
		const before = rowOf(h.terminal, "second prompt");
		expect(before).toBeLessThanOrEqual(2);

		h.terminal.resize(40, ROWS);
		await h.settle();
		expect(rowOf(h.terminal, "second prompt")).toBe(before);
	});
});

describe("workbench layout", () => {
	it("keeps four content rows and the tail of oversized bottom chrome", () => {
		const bottom = ["a", "b", "c", "d", "e", "f", "g", "h"];
		expect(clampBottomRows(bottom, 10)).toEqual(["c", "d", "e", "f", "g", "h"]);
		expect(clampBottomRows(bottom, 3)).toEqual([]);
		const layout = computeLayout(40, 10, 8);
		expect(layout.bottomTop).toBe(4);
	});

	it("hit-tests content, bottom and off-screen cells", () => {
		const layout = computeLayout(40, 10, 3);
		expect(regionAt(layout, 6, 0)).toBe("content");
		expect(regionAt(layout, 7, 39)).toBe("bottom");
		expect(regionAt(layout, 7, 40)).toBe("outside");
		expect(regionAt(layout, 10, 0)).toBe("outside");
		// The rail and its gap sit right of the content rows only.
		expect(regionAt(layout, 6, 37)).toBe("content");
		expect(regionAt(layout, 6, 38)).toBe("rail");
		expect(regionAt(layout, 6, 39)).toBe("rail");
		expect(regionAt(computeLayout(12, 10, 3), 6, 11)).toBe("content");
	});
});

describe("workbench selection", () => {
	function copyHarness() {
		const copied: string[] = [];
		const h = harness({
			copyToClipboard: async text => {
				copied.push(text);
			},
		});
		const send = async (data: string) => {
			h.terminal.sendInput(data);
			await h.settle();
		};
		return { ...h, copied, send };
	}

	it("keeps scrolling while a drag rests on the top row and copies every row it passed", async () => {
		useAppKeybindings();
		const h = copyHarness();
		// One block, so rows are not separated by blank lines.
		const block = Array.from({ length: 40 }, (_, i) => `row ${i}`);
		h.transcript.addChild({ render: () => block });
		h.shell.open();
		await h.settle();
		const pressed = plain(h.terminal.getViewport())[3]!;
		const pressedIndex = Number(pressed.split(" ")[1]);

		// Past the row's text: the whole row is selected.
		await h.send(mouse("press", 20, 3));
		await h.send(mouse("drag", 0, 0));
		await Bun.sleep(300);
		await h.settle();
		await h.send(mouse("release", 0, 0));

		expect(h.copied).toHaveLength(1);
		const lines = h.copied[0]!.split("\n");
		const firstIndex = Number(lines[0]!.split(" ")[1]);
		// The viewport top held row pressedIndex - 3; auto-scroll reached rows above it.
		expect(firstIndex).toBeLessThan(pressedIndex - 3);
		expect(lines).toEqual(Array.from({ length: pressedIndex - firstIndex + 1 }, (_, i) => `row ${firstIndex + i}`));
		expect(rowOf(h.terminal, `已复制 ${lines.length} 行`)).toBeGreaterThan(-1);
		expect(h.shell.render(COLUMNS).some(line => line.includes("\x1b[7mrow"))).toBe(true);

		// The next key drops the highlight and the notice, and still reaches the editor.
		await h.send("x");
		expect(h.editor.typed).toBe("x");
		expect(rowOf(h.terminal, "已复制")).toBe(-1);
		expect(h.shell.render(COLUMNS).some(line => line.includes("\x1b[7m"))).toBe(false);
	});

	it("drops a drag whose release went elsewhere instead of copying what the pointer hovers later", async () => {
		useAppKeybindings();
		const h = copyHarness();
		const block = Array.from({ length: 40 }, (_, i) => `row ${i}`);
		h.transcript.addChild({ render: () => block });
		h.shell.open();
		await h.settle();

		await h.send(mouse("press", 0, 3));
		await h.send(mouse("drag", 3, 5));
		// The next report is a plain move: the button came up while something else had the pointer.
		await h.send(mouse("move", 3, 0));
		await Bun.sleep(150);
		await h.settle();
		expect(h.shell.render(COLUMNS).some(line => line.includes("\x1b[7m"))).toBe(false);
		await h.send(mouse("press", 0, 6));
		await h.send(mouse("release", 0, 6));
		expect(h.copied).toEqual([]);
		// It did not keep scrolling either: the tail is still in view.
		expect(rowOf(h.terminal, "row 39")).toBeGreaterThan(-1);
	});

	it("copies the word on a double click and the row on a triple click; a plain click copies nothing", async () => {
		useAppKeybindings();
		const h = copyHarness();
		h.transcript.addChild({ render: () => ["alpha beta gamma"] });
		h.shell.open();
		await h.settle();
		const row = rowOf(h.terminal, "alpha beta");
		const click = async () => {
			await h.send(mouse("press", 7, row));
			await h.send(mouse("release", 7, row));
		};
		await click();
		expect(h.copied).toEqual([]);
		await click();
		await click();
		expect(h.copied).toEqual(["beta", "alpha beta gamma"]);
	});
});
