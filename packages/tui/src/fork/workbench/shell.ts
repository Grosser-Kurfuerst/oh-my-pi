/**
 * WorkbenchShell: a persistent fullscreen overlay that re-renders the live
 * composer roots (`ui.children`) inside its own layout. Upstream components
 * are only read and rendered, never modified: the transcript and the roots
 * above it become a scrollable content area, the roots below it (HUDs,
 * editor, status line) stay pinned at the bottom. A one-column rail beside
 * the content marks every user prompt and jumps to it on click.
 *
 * While the shell owns the alternate screen the composer commits no native
 * history; closing it hands the normal buffer back and the composer catches up.
 */
import * as logger from "@oh-my-pi/pi-utils/logger";
import { stripPromptZones } from "../../chat/transcript-outline";
import {
	type AnimationFrame,
	TranscriptContainer,
	type TranscriptPresentationTarget,
	trimBlankEdges,
} from "../../chrome/transcript-container";
import { ScrollView } from "../../components/scroll-view";
import { getKeybindings } from "../../keybindings";
import { matchesKey } from "../../keys";
import { routeSgrMouseInput, type SgrMouseEvent } from "../../mouse";
import { isNativeRendering, onNativeRenderingChange } from "../../native/state";
import { theme } from "../../theme";
import {
	type Component,
	type Container,
	CURSOR_MARKER,
	type Focusable,
	type OverlayFocusOwner,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
} from "../../tui";
import { padding, truncateToWidth, visibleWidth } from "../../utils";
import { clampBottomRows, computeLayout, contentColumn, mainColumn, regionAt, type WorkbenchLayout } from "./layout";
import { nearestTurn, renderRail } from "./rail";
import { currentTurn, isUserTurnBlock, jumpOffset, promptLabel, type TurnEntry, turnTarget } from "./turn-index";

/** The parts of InteractiveMode the shell reads; InteractiveMode satisfies it structurally. */
export interface WorkbenchHost {
	readonly ui: TUI;
	readonly chatContainer: TranscriptContainer;
	readonly editorContainer: Container;
}

export interface WorkbenchShellOptions {
	/** Show a short user-facing notice (e.g. why the shell cannot open). */
	notify?(message: string): void;
}

const SHELL_OVERLAY: OverlayOptions = {
	anchor: "top-left",
	width: "100%",
	maxHeight: "100%",
	margin: 0,
	fullscreen: true,
};

const WHEEL_STEP = 3;
/** Matches the shared tool spinner cadence so animated blocks agree on their frame. */
const ANIMATION_TICK_MS = 80;
/** How often a shell hidden behind an inline popup checks whether it may come back. */
const SUSPEND_POLL_MS = 150;
const CONSUMED = { consume: true } as const;
/** Control bytes (C0, DEL, C1) mark keys and escape sequences; anything else is text that would type into the editor. */
const CONTROL_BYTES = /[\x00-\x1f\x7f-\x9f]/;

/** Where the viewport sat relative to a prompt, to restore after a reflow. */
interface TurnAnchor {
	readonly turn: number;
	readonly offset: number;
}

interface RenderedPart {
	/** The array the component returned; unchanged identity means unchanged rows. */
	readonly source: readonly string[];
	readonly rows: readonly string[];
}

type OverlayEntry = TUI["overlayStack"][number];

export class WorkbenchShell implements Component, Focusable, OverlayFocusOwner {
	readonly #host: WorkbenchHost;
	readonly #notify: ((message: string) => void) | undefined;
	readonly #scroll = new ScrollView([], { height: 0, scrollbar: "never", followTail: true });
	#handle: OverlayHandle | undefined;
	#focused = false;
	#suspendPoll: NodeJS.Timeout | undefined;
	#layout: WorkbenchLayout | undefined;
	#parts = new WeakMap<Component, RenderedPart>();
	/** Per-part arrays the last content buffer was joined from. */
	#contentKey: readonly (readonly string[])[] = [];
	#contentRows: readonly string[] = [];
	#userTurns = 0;
	#pinToTail = false;
	/** User prompts in the current content buffer. */
	#turns: readonly TurnEntry[] = [];
	/** Turn label per cached prompt rows, so a streaming frame does not re-derive every label. */
	#labels = new WeakMap<readonly string[], string>();
	/** Whether each transcript block starts a user turn; fixed for a block's lifetime. */
	#turnBlocks = new WeakMap<Component, boolean>();
	/** Turn jumps requested since the last frame; applied once the content is laid out. */
	#pendingJumps = 0;
	/** Width the content buffer was last laid out at; a change reflows it. */
	#contentWidth = 0;
	/**
	 * Read mode: plain keys scroll and jump instead of typing. Holds the focus it
	 * started on (`null` when nothing was focused); `undefined` when not reading.
	 */
	#readingFocus: Component | null | undefined;
	/** Rail row the pointer is over; resolved to a turn per frame, so it survives a re-index. */
	#hoverRow: number | undefined;
	/** Last focus target the shell hosted; restored when an overlay above hands focus back. */
	#hostedFocus: Component | undefined;
	/** Editor-area children when {@link #hostedFocus} was seen; a different slot makes it stale. */
	#hostedSlot: readonly Component[] = [];
	/** Transcript root last found in `ui.children`. */
	#transcript: TranscriptContainer | undefined;

	constructor(host: WorkbenchHost, options: WorkbenchShellOptions = {}) {
		this.#host = host;
		this.#notify = options.notify;
	}

	/** Register the shell's input routing; returns a disposer. */
	install(): () => void {
		const removeInput = this.#host.ui.addInputListener(data => this.#onInput(data));
		const removeNative = onNativeRenderingChange(on => {
			if (on) this.close();
		});
		return () => {
			removeInput();
			removeNative();
			this.close();
		};
	}

	get isOpen(): boolean {
		return this.#handle !== undefined;
	}

	/** Open, not stepped aside, and above every other visible overlay. */
	get isFrontmost(): boolean {
		return this.#handle !== undefined && this.#topVisibleOverlay()?.component === this;
	}

	open(): boolean {
		if (this.#handle) return true;
		if (isNativeRendering()) {
			this.#notify?.("工作台不支持当前的原生渲染模式");
			return false;
		}
		const ui = this.#host.ui;
		const previous = ui.getFocused();
		this.#pinToTail = true;
		this.#handle = ui.showOverlay(this, SHELL_OVERLAY);
		// showOverlay focused the shell itself; hand the keys straight back.
		const target = previous && this.ownsOverlayFocusTarget(previous) ? previous : this.#defaultFocusTarget();
		if (target) ui.setFocus(target);
		return true;
	}

	close(): void {
		const handle = this.#handle;
		if (!handle) return;
		this.#handle = undefined;
		this.#stopSuspendPoll();
		const ui = this.#host.ui;
		const focused = ui.getFocused();
		handle.hide();
		// hide() restores the focus captured at open; keep whatever took it since (an inline selector).
		if (focused && focused !== this && !this.#isOverlayComponent(focused) && ui.getFocused() !== focused) {
			ui.setFocus(focused);
		}
		this.#releaseCommittedCaches();
		this.#parts = new WeakMap();
		this.#contentKey = [];
		this.#contentRows = [];
		this.#scroll.setLines([]);
		this.#turns = [];
		this.#pendingJumps = 0;
		this.#contentWidth = 0;
		this.#readingFocus = undefined;
		this.#hoverRow = undefined;
		this.#hostedFocus = undefined;
		this.#hostedSlot = [];
		this.#transcript = undefined;
	}

	toggle(): void {
		if (this.#handle) this.close();
		else this.open();
	}

	// --- Focus delegation -----------------------------------------------------

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
		// Focus lands on the shell when an overlay above it closes; return it to the editor area.
		if (value) queueMicrotask(() => this.#reclaimFocus());
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component !== this && !this.#isOverlayComponent(component);
	}

	handleInput(data: string): void {
		this.#defaultFocusTarget()?.handleInput?.(data);
	}

	#reclaimFocus(): void {
		const ui = this.#host.ui;
		if (!this.#handle || ui.getFocused() !== this) return;
		const target = this.#hostedFocusIfCurrent() ?? this.#defaultFocusTarget();
		if (target) ui.setFocus(target);
	}

	/**
	 * The last hosted target while the editor slot still holds what it held then.
	 * Covers targets nested inside a slot child (an overlay panel's select list);
	 * once the slot is swapped (an ask dialog replaced the editor) it is stale.
	 */
	#hostedFocusIfCurrent(): Component | undefined {
		const hosted = this.#hostedFocus;
		if (!hosted || !this.ownsOverlayFocusTarget(hosted)) return undefined;
		const slot = this.#host.editorContainer.children;
		const unchanged = slot.length === this.#hostedSlot.length && slot.every((c, i) => c === this.#hostedSlot[i]);
		return unchanged ? hosted : undefined;
	}

	#recordHostedFocus(): void {
		const focused = this.#host.ui.getFocused();
		if (!focused || !this.ownsOverlayFocusTarget(focused)) return;
		this.#hostedFocus = focused;
		this.#hostedSlot = [...this.#host.editorContainer.children];
	}

	/** The editor, or the inline selector currently standing in for it. */
	#defaultFocusTarget(): Component | undefined {
		return this.#host.editorContainer.children.find(child => child.handleInput !== undefined);
	}

	#isOverlayComponent(component: Component): boolean {
		return this.#host.ui.overlayStack.some(entry => entry.component === component);
	}

	// --- Input ------------------------------------------------------------------

	#onInput(data: string): { consume: true } | undefined {
		const keybindings = getKeybindings();
		if (!this.#handle) {
			if (this.#host.ui.hasOverlay()) return undefined;
			if (keybindings.matches(data, "fork.workbench.toggle")) {
				this.open();
				return CONSUMED;
			}
			// "Back to my last prompt" works from anywhere: open, read, jump.
			if (keybindings.matches(data, "fork.workbench.prevTurn") && !isNativeRendering()) {
				if (this.open()) {
					this.#startReading();
					this.#jump(-1);
				}
				return CONSUMED;
			}
			return undefined;
		}
		if (!this.isFrontmost) return undefined;
		if (data.startsWith("\x1b[<")) {
			// Every report is ours while the shell is on top; unparsed bytes must not reach the editor.
			routeSgrMouseInput(data, event => this.#handleMouse(event));
			return CONSUMED;
		}
		if (keybindings.matches(data, "fork.workbench.toggle")) {
			this.close();
			return CONSUMED;
		}
		if (keybindings.matches(data, "fork.workbench.prevTurn")) {
			this.#jump(-1);
			return CONSUMED;
		}
		if (keybindings.matches(data, "fork.workbench.nextTurn")) {
			this.#jump(1);
			return CONSUMED;
		}
		if (keybindings.matches(data, "fork.workbench.read")) {
			this.#startReading();
			this.#host.ui.requestRender();
			return CONSUMED;
		}
		return this.#readingFocus === undefined ? undefined : this.#handleReadKey(data);
	}

	/** Read-mode keys. Unbound text is swallowed so a stray letter never lands in the prompt. */
	#handleReadKey(data: string): { consume: true } | undefined {
		if (this.#endStaleReading()) return undefined;
		const scroll = this.#scroll;
		const halfPage = Math.max(1, Math.floor((this.#layout?.bottomTop ?? 0) / 2));
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "i") this.#stopReading();
		else if (data === "j") scroll.scroll(1);
		else if (data === "k") scroll.scroll(-1);
		// less/vim habits; in the editor these would exit omp (ctrl+d on an empty draft) or wipe the draft.
		else if (matchesKey(data, "ctrl+d")) scroll.scroll(halfPage);
		else if (matchesKey(data, "ctrl+u")) scroll.scroll(-halfPage);
		else if (matchesKey(data, "space")) scroll.page(1);
		else if (data === "[") this.#jump(-1);
		else if (data === "]") this.#jump(1);
		else if (data === "g") scroll.scrollToTop();
		else if (data === "G") scroll.scrollToBottom();
		else if (!scroll.handleScrollKey(data) && CONTROL_BYTES.test(data)) return undefined;
		this.#host.ui.requestRender();
		return CONSUMED;
	}

	#startReading(): void {
		this.#readingFocus = this.#host.ui.getFocused();
	}

	#stopReading(): void {
		this.#readingFocus = undefined;
	}

	/**
	 * Leave read mode once another hosted component took the keys (a dialog
	 * replaced the editor), so neither the help line nor the key routing
	 * outlives it. Focus on the shell itself or an overlay above is transient.
	 */
	#endStaleReading(): boolean {
		if (this.#readingFocus === undefined) return false;
		const focused = this.#host.ui.getFocused();
		if (!focused || focused === this.#readingFocus || !this.ownsOverlayFocusTarget(focused)) return false;
		this.#stopReading();
		return true;
	}

	/** Queue a jump to the previous (-1) or next (+1) prompt for the next frame. */
	#jump(delta: -1 | 1): void {
		this.#pendingJumps += delta;
		this.#host.ui.requestRender();
	}

	#applyPendingJumps(): void {
		const steps = this.#pendingJumps;
		this.#pendingJumps = 0;
		const delta = Math.sign(steps) as -1 | 1;
		for (let step = 0; step < Math.abs(steps); step++) {
			const target = turnTarget(this.#turns, this.#scroll.getScrollOffset(), delta);
			// Past the last prompt there is still the answer below it.
			if (target === undefined) {
				if (delta > 0) this.#scroll.scrollToBottom();
				return;
			}
			this.#scroll.setScrollOffset(jumpOffset(this.#turns[target]!));
		}
	}

	#handleMouse(event: SgrMouseEvent): boolean {
		const layout = this.#layout;
		if (!layout) return false;
		const region = regionAt(layout, event.row, event.col);
		this.#setHoverRow(region === "rail" ? event.row : undefined);
		if (region === "outside") return false;
		if (event.wheel !== null) {
			this.#scroll.scroll(event.wheel * WHEEL_STEP);
		} else if (event.leftClick && region === "rail") {
			const turn = this.#railTurnAt(layout, event.row);
			if (turn !== undefined) this.#scroll.setScrollOffset(jumpOffset(this.#turns[turn]!));
		} else if (event.leftClick && region === "bottom") {
			this.#stopReading();
		} else {
			return true;
		}
		this.#host.ui.requestRender();
		return true;
	}

	#railTurnAt(layout: WorkbenchLayout, row: number): number | undefined {
		return nearestTurn(this.#turns, layout.bottomTop, this.#railTotal(layout), row);
	}

	/** Rows the rail spans; short content maps one-to-one instead of stretching. */
	#railTotal(layout: WorkbenchLayout): number {
		return Math.max(this.#contentRows.length, layout.bottomTop);
	}

	/** Pointer moves repaint only when the hovered rail row changes. */
	#setHoverRow(row: number | undefined): void {
		if (row === this.#hoverRow) return;
		this.#hoverRow = row;
		this.#host.ui.requestRender();
	}

	// --- Rendering --------------------------------------------------------------

	invalidate(): void {
		this.#parts = new WeakMap();
		this.#contentKey = [];
		this.#scroll.invalidate();
	}

	render(width: number): readonly string[] {
		if (!this.#handle) return [];
		const ui = this.#host.ui;
		this.#recordHostedFocus();
		this.#endStaleReading();
		const top = this.#topVisibleOverlay();
		if (top && top.component !== this && top.options?.fullscreen !== true) {
			// An inline popup on top drops the terminal back to the normal buffer, where a
			// fullscreen frame would cover the transcript. Step aside until it closes.
			this.#suspend();
			return [];
		}

		const roots = ui.children;
		const chat = this.#mountedTranscript(roots);
		const chatIndex = chat ? roots.indexOf(chat) : -1;
		const main = mainColumn(width);
		const contentWidth = contentColumn(main).width;

		const bottomRoots = chatIndex === -1 ? [] : roots.slice(chatIndex + 1);
		const bottom: string[] = [];
		for (const root of bottomRoots) bottom.push(...root.render(main.width));
		const bottomLines = clampBottomRows(bottom, ui.terminal.rows);
		const layout = computeLayout(width, ui.terminal.rows, bottomLines.length);
		this.#layout = layout;

		// No transcript mounted (never after init): everything scrolls, nothing is pinned.
		const headRoots = chatIndex === -1 ? roots : roots.slice(0, chatIndex);
		const anchor = this.#takeReflowAnchor(contentWidth);
		const content = this.#renderContent(headRoots, chat?.children ?? [], contentWidth);
		if (content !== this.#contentRows) {
			this.#contentRows = content;
			this.#scroll.setLines(content);
		}
		// Read-mode help keeps its own row; the other hints cover the last content row while they show.
		const reserved = this.#readingFocus === undefined ? 0 : 1;
		this.#scroll.setHeight(Math.max(0, layout.bottomTop - reserved));
		const anchored = anchor && this.#turns[anchor.turn];
		if (anchored) this.#scroll.setScrollOffset(anchored.row + anchor.offset);
		if (this.#pinToTail) {
			this.#pinToTail = false;
			this.#scroll.scrollToBottom();
		}
		this.#applyPendingJumps();

		const lines = this.#renderViewport(layout);
		lines.push(...bottomLines);
		return lines;
	}

	/** Content rows, the status hint over the last one, and the rail beside them. */
	#renderViewport(layout: WorkbenchLayout): string[] {
		const width = layout.content.width;
		const lines = [...this.#scroll.render(width)];
		const covers = lines.length === layout.bottomTop;
		while (lines.length < layout.bottomTop) lines.push("");
		const below = this.#contentRows.length - this.#scroll.getVisibleRange().end;
		// A hint on the last content row hides that row too.
		const hint = this.#statusHint(layout, below > 0 ? below + (covers ? 1 : 0) : 0);
		if (hint && layout.bottomTop > 0) lines[layout.bottomTop - 1] = truncateToWidth(hint, width);
		const rail = layout.rail;
		if (!rail) return lines;
		const turns = this.#turns;
		const offset = this.#scroll.getScrollOffset();
		const cells = renderRail(
			turns,
			layout.bottomTop,
			this.#railTotal(layout),
			this.#scroll.getVisibleRange(),
			currentTurn(turns, offset),
		);
		const gap = padding(rail.width - 1);
		return lines.map((line, y) => `${line}${padding(width - visibleWidth(line))}${gap}${cells[y] ?? ""}`);
	}

	/**
	 * One line on the last content row: the hovered prompt, read-mode help, or
	 * how much is below (`hidden` rows, 0 at the end).
	 */
	#statusHint(layout: WorkbenchLayout, hidden: number): string | undefined {
		const row = this.#hoverRow;
		// A resize can drop the rail or shrink the content area under a stale pointer row.
		const onRail = row !== undefined && layout.rail !== undefined && row < layout.bottomTop;
		const hover = onRail ? this.#railTurnAt(layout, row) : undefined;
		if (hover !== undefined) {
			return theme.fg("accent", `第 ${hover + 1}/${this.#turns.length} 轮 · ${this.#turns[hover]!.label}`);
		}
		const more = hidden > 0 ? `↓ 下方还有 ${hidden} 行` : "";
		if (this.#readingFocus !== undefined) {
			const help = "阅读 · j/k 滚动 · [ ] 跳轮 · g/G 顶/底 · Esc 返回";
			return theme.fg("dim", more ? `${help} · ${more}` : help);
		}
		return more ? theme.fg("dim", `${more} · 滚轮向下回到底部`) : undefined;
	}

	/**
	 * When a width change is about to reflow the content, the prompt the
	 * viewport is in and how far past it; records the new width. At the tail
	 * the scroll view's own follow keeps it there.
	 */
	#takeReflowAnchor(width: number): TurnAnchor | undefined {
		if (width === this.#contentWidth) return undefined;
		this.#contentWidth = width;
		const top = this.#scroll.getScrollOffset();
		if (top >= this.#scroll.getMaxScrollOffset()) return undefined;
		const turn = currentTurn(this.#turns, top);
		return turn === -1 ? undefined : { turn, offset: top - this.#turns[turn]!.row };
	}

	/**
	 * Head roots verbatim, then transcript blocks trimmed and separated by one
	 * blank row like the transcript's own full render. Reuses the previous buffer
	 * when no part changed, so an idle frame costs one cache probe per block.
	 */
	#renderContent(headRoots: readonly Component[], blocks: readonly Component[], width: number): readonly string[] {
		const now = performance.now();
		const frame: AnimationFrame = { now, tick: Math.floor(now / ANIMATION_TICK_MS) };
		const headParts = headRoots.map(root => this.#renderPart(root, width, false));
		const blockParts: (readonly string[])[] = [];
		/** Parallel to `blockParts`: the block when it starts a user turn. */
		const turnBlocks: (Component | undefined)[] = [];
		let userTurns = 0;
		for (const block of blocks) {
			// Unbounded rows: the shell scrolls whole blocks instead of the composer's viewport budget.
			(block as Component & TranscriptPresentationTarget).setTranscriptAllocation?.(Number.MAX_SAFE_INTEGER, frame);
			const turn = this.#startsTurn(block);
			if (turn) userTurns++;
			const rows = this.#renderPart(block, width, true);
			if (rows.length === 0) continue;
			blockParts.push(rows);
			turnBlocks.push(turn ? block : undefined);
		}
		// A new prompt from the user follows the conversation again.
		if (userTurns > this.#userTurns) this.#pinToTail = true;
		this.#userTurns = userTurns;

		const key = [...headParts, ...blockParts];
		if (key.length === this.#contentKey.length && key.every((part, index) => part === this.#contentKey[index])) {
			return this.#contentRows;
		}
		this.#contentKey = key;
		const rows: string[] = [];
		const turns: TurnEntry[] = [];
		for (const part of headParts) rows.push(...part);
		blockParts.forEach((part, index) => {
			if (index > 0) rows.push("");
			const block = turnBlocks[index];
			if (block) turns.push({ row: rows.length, label: this.#labelOf(block, part, width) });
			rows.push(...part);
		});
		this.#turns = turns;
		return rows;
	}

	#startsTurn(block: Component): boolean {
		let turn = this.#turnBlocks.get(block);
		if (turn === undefined) {
			turn = isUserTurnBlock(block);
			this.#turnBlocks.set(block, turn);
		}
		return turn;
	}

	#labelOf(block: Component, rows: readonly string[], width: number): string {
		let label = this.#labels.get(rows);
		if (label === undefined) {
			label = promptLabel(block, rows, width);
			this.#labels.set(rows, label);
		}
		return label;
	}

	#renderPart(component: Component, width: number, trim: boolean): readonly string[] {
		const source = component.render(width);
		const cached = this.#parts.get(component);
		if (cached?.source === source) return cached.rows;
		// The content area never hosts the hardware cursor, and OSC 133 zones garble alt-screen rows.
		let rows = stripPromptZones(source);
		if (rows.some(row => row.includes(CURSOR_MARKER))) rows = rows.map(row => row.replaceAll(CURSOR_MARKER, ""));
		if (trim) rows = trimBlankEdges(rows);
		this.#parts.set(component, { source, rows });
		return rows;
	}

	/**
	 * The transcript on screen. A session rebuild points `host.chatContainer` at
	 * a staged, unmounted container while the old one stays visible, so the
	 * mounted root is looked up rather than trusted.
	 */
	#mountedTranscript(roots: readonly Component[]): TranscriptContainer | undefined {
		const host = this.#host.chatContainer;
		if (roots.includes(host)) this.#transcript = host;
		else if (!this.#transcript || !roots.includes(this.#transcript)) {
			this.#transcript = roots.find(root => root instanceof TranscriptContainer);
		}
		return this.#transcript;
	}

	/** Committed blocks rendered for the shell would otherwise keep their row caches for the session. */
	#releaseCommittedCaches(): void {
		const chat = this.#transcript;
		if (!chat) return;
		const states = chat.blockStates();
		chat.children.forEach((child, index) => {
			if (states[index] !== "committed") return;
			try {
				child.releaseRenderCaches?.();
			} catch (err) {
				logger.warn("Workbench failed to release a transcript block's render caches", {
					component: child.constructor.name,
					error: String(err),
				});
			}
		});
	}

	// --- Inline popups ------------------------------------------------------------

	#topVisibleOverlay(): OverlayEntry | undefined {
		const ui = this.#host.ui;
		const stack = ui.overlayStack;
		for (let index = stack.length - 1; index >= 0; index--) {
			const entry = stack[index]!;
			if (entry.hidden) continue;
			if (entry.options?.visible && !entry.options.visible(ui.terminal.columns, ui.terminal.rows)) continue;
			return entry;
		}
		return undefined;
	}

	#suspend(): void {
		if (this.#suspendPoll) return;
		this.#suspendPoll = setInterval(() => this.#resumeWhenClear(), SUSPEND_POLL_MS);
		this.#suspendPoll.unref?.();
		// Deferred: this runs inside a render pass that is compositing the overlay stack.
		queueMicrotask(() => this.#handle?.setHidden(true));
	}

	#resumeWhenClear(): void {
		if (!this.#handle) {
			this.#stopSuspendPoll();
			return;
		}
		const ui = this.#host.ui;
		if (ui.hasOverlay()) return;
		this.#stopSuspendPoll();
		// setHidden(false) focuses the shell; keep whatever the popup's owner focused on close
		// (an ask dialog that took the editor slot meanwhile) instead of reclaiming a stale target.
		const focused = ui.getFocused();
		this.#handle.setHidden(false);
		if (focused && this.ownsOverlayFocusTarget(focused)) ui.setFocus(focused);
	}

	#stopSuspendPoll(): void {
		if (!this.#suspendPoll) return;
		clearInterval(this.#suspendPoll);
		this.#suspendPoll = undefined;
	}
}
