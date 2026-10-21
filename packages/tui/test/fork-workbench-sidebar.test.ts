import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { WorkbenchShell, type WorkbenchShellOptions } from "@oh-my-pi/pi-tui/fork/workbench/shell";
import {
	ABORT_CONFIRM_MS,
	SessionSidebar,
	type SidebarDeps,
	type SidebarSession,
} from "@oh-my-pi/pi-tui/fork/workbench/sidebar";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { type Component, Container, type Focusable, getKeybindings, setKeybindings } from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const F2 = "\x1bOQ";
const MINUTE = 60_000;
const NOW = Date.parse("2026-10-21T12:00:00Z");

function session(name: string, minutesAgo: number): SidebarSession {
	return {
		path: `/sessions/${name}.jsonl`,
		id: name,
		cwd: "/project",
		modified: new Date(NOW - minutesAgo * MINUTE),
		size: 1,
		firstMessage: name,
		allMessagesText: name,
		displayName: name,
	};
}

/** Fake app side: a fixed listing, a mutable current session and streaming flag, recorded actions. */
function fakeDeps(sessions: SidebarSession[], current?: string) {
	const state = { current, streaming: false, calls: [] as string[] };
	const deps: SidebarDeps = {
		listSessions: async () => sessions,
		projectName: () => "project",
		currentPath: () => state.current,
		isStreaming: () => state.streaming,
		switchTo: async path => {
			state.calls.push(`switch ${path}`);
			state.current = path;
		},
		newSession: async () => {
			state.calls.push("new");
		},
	};
	return { deps, state };
}

function plain(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
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
	vi.restoreAllMocks();
});

function useAppKeybindings(): void {
	previousKeybindings = getKeybindings() as KeybindingsManager;
	setKeybindings(KeybindingsManager.inMemory());
}

describe("workbench sidebar", () => {
	function sidebar(sessions: SidebarSession[], current?: string) {
		useAppKeybindings();
		spyOn(Date, "now").mockReturnValue(NOW);
		const fake = fakeDeps(sessions, current);
		const events = { changed: 0, exited: 0 };
		const view = new SessionSidebar(fake.deps, {
			requestRender: () => {},
			onSessionChanged: () => events.changed++,
			onExit: () => events.exited++,
		});
		return { view, events, ...fake };
	}

	it("lists sessions newest first with their age and marks the current one", async () => {
		useAppKeybindings();
		const s = sidebar([session("old", 3 * 24 * 60), session("fresh", 0), session("mid", 125)], "/sessions/mid.jsonl");
		await s.view.refresh();
		const rows = plain(s.view.render(30, 7, false));
		expect(rows[0]).toBe("project 3");
		expect(rows.slice(2, 5)).toEqual([
			"  fresh                    now",
			"● mid                       2h",
			"  old                       3d",
		]);
		// The list keys only work once focused: until then the hint names the focus key.
		expect(rows[6]).toBe("f2 选择");
		expect(plain(s.view.render(30, 7, true))[6]).toBe("/ 过滤  n 新建");
	});

	it("asks for a second confirm before leaving a running turn, and lets an expired one lapse", async () => {
		const s = sidebar([session("current", 0), session("other", 5)], "/sessions/current.jsonl");
		await s.view.refresh();
		s.state.streaming = true;
		s.view.handleKey(DOWN);

		s.view.handleKey(ENTER);
		await Bun.sleep(0);
		expect(s.state.calls).toEqual([]);
		expect(plain(s.view.render(30, 6, true))[5]).toBe("再次确认将中止当前回合");

		// Too late: the second confirm only arms again.
		vi.spyOn(Date, "now").mockReturnValue(NOW + ABORT_CONFIRM_MS);
		s.view.handleKey(ENTER);
		await Bun.sleep(0);
		expect(s.state.calls).toEqual([]);

		s.view.handleKey(ENTER);
		await Bun.sleep(0);
		expect(s.state.calls).toEqual(["switch /sessions/other.jsonl"]);
		expect(s.events.changed).toBe(1);
	});

	it("filters with / and opens the best match; letters never reach the editor", async () => {
		const s = sidebar([session("alpha", 1), session("beta", 2), session("gamma", 3)], "/sessions/alpha.jsonl");
		await s.view.refresh();
		expect(s.view.handleKey("x")).toBe(true);
		for (const key of ["/", "g", "a", "m"]) s.view.handleKey(key);
		expect(plain(s.view.render(30, 6, true)).slice(0, 3)).toEqual([
			"project 1/3",
			"─".repeat(30),
			"  gamma                     3m",
		]);

		s.view.handleKey(ENTER);
		await Bun.sleep(0);
		expect(s.state.calls).toEqual(["switch /sessions/gamma.jsonl"]);
	});

	it("does not open the session below the window when the hint row is clicked", async () => {
		const many = Array.from({ length: 20 }, (_, i) => session(`s${i}`, i + 1));
		const s = sidebar(many, "/sessions/s0.jsonl");
		await s.view.refresh();
		const rows = plain(s.view.render(30, 12, false));
		expect(rows[10]).toMatch(/^ {2}s8 /);

		s.view.click(11);
		await Bun.sleep(0);
		expect(s.state.calls).toEqual([]);
		s.view.click(10);
		await Bun.sleep(0);
		expect(s.state.calls).toEqual(["switch /sessions/s8.jsonl"]);
	});

	it("shows a new session the listing leaves out, with a spinner while its turn runs", async () => {
		const s = sidebar([session("older", 5)], "/sessions/new.jsonl");
		await s.view.refresh();
		expect(plain(s.view.render(30, 6, false)).slice(2, 4)).toEqual([
			"● 新会话                   now",
			"  older                     5m",
		]);
		s.state.streaming = true;
		const marker = plain(s.view.render(30, 6, false))[2]!.split(" ")[0];
		expect(theme.spinnerFrames).toContain(marker);
	});

	it("creates a session on n and gives the keys back on escape", async () => {
		const s = sidebar([session("only", 1)], "/sessions/only.jsonl");
		await s.view.refresh();
		s.view.handleKey("n");
		await Bun.sleep(0);
		expect(s.state.calls).toEqual(["new"]);
		s.view.handleKey(ESC);
		expect(s.events.exited).toBe(1);
	});
});

/** Stand-in for the prompt editor. */
class TypingEditor implements Component, Focusable {
	focused = false;
	typed = "";

	handleInput(data: string): void {
		this.typed += data;
	}

	render(): string[] {
		return ["> draft"];
	}
}

/** SGR left press and release at a 0-based cell. */
function mouseClick(col: number, row: number): string[] {
	return [`\x1b[<0;${col + 1};${row + 1}M`, `\x1b[<0;${col + 1};${row + 1}m`];
}

describe("workbench shell sidebar", () => {
	function harness(
		columns: number,
		options: (deps: SidebarDeps) => WorkbenchShellOptions = deps => ({ sidebar: deps }),
	) {
		useAppKeybindings();
		const terminal = new VirtualTerminal(columns, 12);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		transcript.addChild({ render: () => ["answer"] });
		const editor = new TypingEditor();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		composer.setRuntimeChildren([transcript, editorContainer], { transientChrome: [editorContainer] });
		composer.start({ playWelcomeIntro: false });
		composer.ui.setFocus(editor);
		const fake = fakeDeps([session("first", 1), session("second", 2)], "/sessions/first.jsonl");
		let listed = 0;
		const listSessions = fake.deps.listSessions;
		fake.deps.listSessions = () => {
			listed++;
			return listSessions();
		};
		const host = { ui: composer.ui, chatContainer: transcript, editorContainer };
		const shell = new WorkbenchShell(host, options(fake.deps));
		const uninstall = shell.install();
		shell.open();
		cleanups.push(() => {
			uninstall();
			composer.stop();
		});
		const settle = async () => {
			// Let a list load resolve, then paint what it requested.
			await scheduler.settle(terminal);
			await Bun.sleep(0);
			await scheduler.settle(terminal);
		};
		const press = async (data: string) => {
			terminal.sendInput(data);
			await settle();
		};
		const screen = () => plain(terminal.getViewport());
		return {
			terminal,
			editor,
			host,
			shell,
			deps: fake.deps,
			state: fake.state,
			listed: () => listed,
			settle,
			press,
			screen,
		};
	}

	it("shows the session list beside the transcript on wide terminals and switches on click", async () => {
		const h = harness(120);
		await h.settle();
		const screen = h.screen();
		// 22% of 120 columns, then " │ ".
		expect(screen[0]).toMatch(/^project 2 +│ answer/);
		const secondRow = screen.findIndex(row => row.includes("second"));
		expect(secondRow).toBe(3);

		for (const report of mouseClick(4, secondRow)) await h.press(report);
		expect(h.state.calls).toEqual(["switch /sessions/second.jsonl"]);
		expect(h.screen()[3]).toMatch(/^● second/);
	});

	it("shows a known list before any load resolves and keeps it while a rebind reloads", async () => {
		const loading = () => Promise.withResolvers<SidebarSession[]>().promise;
		const h = harness(120, deps => ({
			sidebar: { ...deps, listSessions: loading },
			sidebarSessions: [session("cached", 3)],
		}));
		await h.settle();
		expect(h.screen().some(row => row.includes("cached"))).toBe(true);

		h.shell.rebind(h.host, { sidebar: { ...h.deps, listSessions: loading } });
		await h.settle();
		const screen = h.screen();
		expect(screen.some(row => row.includes("cached"))).toBe(true);
		expect(screen.some(row => row.includes("加载中"))).toBe(false);
	});

	it("starts collapsed below 100 columns without listing sessions; the sidebar key opens it with the keys", async () => {
		const h = harness(90);
		await h.settle();
		expect(h.screen()[0]).toMatch(/^answer/);
		expect(h.listed()).toBe(0);

		await h.press(F2);
		expect(h.screen()[0]).toMatch(/^project 2/);
		await h.press(DOWN);
		await h.press(ENTER);
		expect(h.state.calls).toEqual(["switch /sessions/second.jsonl"]);
		// The switch hands the keys back to the editor.
		await h.press("x");
		expect(h.editor.typed).toBe("x");

		await h.press(F2);
		await h.press(F2);
		expect(h.screen()[0]).toMatch(/^answer/);
	});
});
