/**
 * WorkbenchShell: a persistent fullscreen overlay that re-renders the live
 * composer roots (`ui.children`) inside its own layout. Upstream components
 * are only read and rendered, never modified: the transcript and the roots
 * above it become a scrollable content area, the roots below it (HUDs,
 * editor, status line) stay pinned at the bottom.
 *
 * While the shell owns the alternate screen the composer commits no native
 * history; closing it hands the normal buffer back and the composer catches up.
 */
import * as logger from "@oh-my-pi/pi-utils/logger";
import { stripPromptZones } from "../../chat/transcript-outline";
import { UserMessageComponent } from "../../chat/user-message";
import {
	type AnimationFrame,
	TranscriptContainer,
	type TranscriptPresentationTarget,
	trimBlankEdges,
} from "../../chrome/transcript-container";
import { ScrollView } from "../../components/scroll-view";
import { getKeybindings } from "../../keybindings";
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
import { truncateToWidth } from "../../utils";
import { clampBottomRows, computeLayout, mainColumn, regionAt, type WorkbenchLayout } from "./layout";

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
			if (keybindings.matches(data, "fork.workbench.toggle") && !this.#host.ui.hasOverlay()) {
				this.open();
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
		return undefined;
	}

	#handleMouse(event: SgrMouseEvent): boolean {
		const layout = this.#layout;
		if (!layout || regionAt(layout, event.row, event.col) === "outside") return false;
		if (event.wheel !== null) {
			this.#scroll.scroll(event.wheel * WHEEL_STEP);
			this.#host.ui.requestRender();
		}
		return true;
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

		const bottomRoots = chatIndex === -1 ? [] : roots.slice(chatIndex + 1);
		const bottom: string[] = [];
		for (const root of bottomRoots) bottom.push(...root.render(main.width));
		const bottomLines = clampBottomRows(bottom, ui.terminal.rows);
		const layout = computeLayout(width, ui.terminal.rows, bottomLines.length);
		this.#layout = layout;

		// No transcript mounted (never after init): everything scrolls, nothing is pinned.
		const headRoots = chatIndex === -1 ? roots : roots.slice(0, chatIndex);
		const content = this.#renderContent(headRoots, chat?.children ?? [], main.width);
		if (content !== this.#contentRows) {
			this.#contentRows = content;
			this.#scroll.setLines(content);
		}
		this.#scroll.setHeight(layout.bottomTop);
		if (this.#pinToTail) {
			this.#pinToTail = false;
			this.#scroll.scrollToBottom();
		}

		const lines = [...this.#scroll.render(main.width)];
		// The notice covers the last visible row, so that row counts as hidden too.
		const hidden = content.length - this.#scroll.getVisibleRange().end + 1;
		if (hidden > 1 && layout.bottomTop > 0) {
			lines[layout.bottomTop - 1] = theme.fg(
				"dim",
				truncateToWidth(`↓ 下方还有 ${hidden} 行 · 滚轮向下回到底部`, main.width),
			);
		}
		lines.push(...bottomLines);
		return lines;
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
		let userTurns = 0;
		for (const block of blocks) {
			// Unbounded rows: the shell scrolls whole blocks instead of the composer's viewport budget.
			(block as Component & TranscriptPresentationTarget).setTranscriptAllocation?.(Number.MAX_SAFE_INTEGER, frame);
			if (block instanceof UserMessageComponent) userTurns++;
			const rows = this.#renderPart(block, width, true);
			if (rows.length > 0) blockParts.push(rows);
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
		for (const part of headParts) rows.push(...part);
		blockParts.forEach((part, index) => {
			if (index > 0) rows.push("");
			rows.push(...part);
		});
		return rows;
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
