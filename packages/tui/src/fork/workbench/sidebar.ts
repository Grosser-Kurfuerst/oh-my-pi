/**
 * SessionSidebar: the workbench's list of this project's sessions. It only
 * renders and routes keys; listing, switching and creating sessions come from
 * injected deps (coding-agent `fork/workbench.ts`).
 */
import * as logger from "@oh-my-pi/pi-utils/logger";
import { SPINNER_ADVANCE_MS } from "../../components/loader";
import { extractPrintableText } from "../../keys";
import { getKeybindings } from "../../keybindings";
import { rankSessionSearchMatches, type SessionSelectorEntry } from "../../overlays/session-selector";
import { theme } from "../../theme";
import { padding, truncateToWidth, visibleWidth } from "../../utils";

export interface SidebarSession extends SessionSelectorEntry {
	/** Title, first prompt, or a time label: what the row shows. */
	readonly displayName: string;
}

export interface SidebarDeps {
	/** Sessions of the current project, in any order. */
	listSessions(): Promise<SidebarSession[]>;
	/** Header label: the project folder name. */
	projectName(): string;
	currentPath(): string | undefined;
	isStreaming(): boolean;
	switchTo(path: string): Promise<void>;
	newSession(): Promise<void>;
}

export interface SidebarEvents {
	requestRender(): void;
	/** A switch or a new session landed. */
	onSessionChanged(): void;
	/** Esc: give the keys back to the editor. */
	onExit(): void;
}

/** A second confirm within this window switches away from a running turn. */
export const ABORT_CONFIRM_MS = 3000;
/** Header (project, rule) above the list and the hint row below it. */
const HEADER_ROWS = 2;
const FOOTER_ROWS = 1;
const WHEEL_STEP = 3;
/** Confirm key for "new session", next to session paths. */
const NEW_SESSION = "\0new";

/** `now`, `3m`, `2h`, `5d`: age of a session at a glance. */
export function relativeTime(date: Date, now: number): string {
	const minutes = Math.floor((now - date.getTime()) / 60_000);
	if (!Number.isFinite(minutes) || minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export class SessionSidebar {
	readonly #deps: SidebarDeps;
	readonly #events: SidebarEvents;
	/** Newest first. */
	#sessions: readonly SidebarSession[] = [];
	#loaded = false;
	#loadFailed = false;
	/** Row for a current session the listing leaves out (new and still empty), reused while its path holds. */
	#unlisted: SidebarSession | undefined;
	#refreshing: Promise<void> | undefined;
	#refreshQueued = false;
	/** Filter text while `/` filtering; undefined otherwise. */
	#query: string | undefined;
	/** Last ranking, reused while neither the list nor the query changed. */
	#filtered:
		| {
				readonly sessions: readonly SidebarSession[];
				readonly query: string;
				readonly ranked: readonly SidebarSession[];
		  }
		| undefined;
	/** Selected session path; follows the session through refreshes and reordering. */
	#selected: string | undefined;
	/** First list entry on screen. */
	#top = 0;
	/** List rows in the last frame; a page for pageUp/pageDown. */
	#rows = 0;
	/** A keyboard move asked the next frame to scroll the selection into view. */
	#reveal = false;
	/** First confirm while a turn runs; a second on the same target before `until` goes through. */
	#armed: { readonly key: string; readonly until: number } | undefined;
	#busy = false;

	/** `sessions`: a list already known, shown until the first reload. */
	constructor(deps: SidebarDeps, events: SidebarEvents, sessions?: readonly SidebarSession[]) {
		this.#deps = deps;
		this.#events = events;
		if (sessions) this.#setSessions(sessions);
	}

	/** The last loaded list, newest first; undefined before one loaded. */
	get sessions(): readonly SidebarSession[] | undefined {
		return this.#loaded ? this.#sessions : undefined;
	}

	#setSessions(sessions: readonly SidebarSession[]): void {
		this.#sessions = sessions.toSorted((a, b) => b.modified.getTime() - a.modified.getTime());
		this.#loaded = true;
		this.#loadFailed = false;
	}

	/** Reload the list; a call while one runs queues one more run instead of overlapping it. */
	refresh(): Promise<void> {
		if (this.#refreshing) {
			this.#refreshQueued = true;
			return this.#refreshing;
		}
		this.#refreshing = this.#runRefresh();
		return this.#refreshing;
	}

	async #runRefresh(): Promise<void> {
		do {
			this.#refreshQueued = false;
			try {
				this.#setSessions(await this.#deps.listSessions());
			} catch (err) {
				this.#loadFailed = true;
				logger.warn("Workbench failed to list sessions", { error: String(err) });
			}
			this.#events.requestRender();
		} while (this.#refreshQueued);
		this.#refreshing = undefined;
	}

	// --- Input ------------------------------------------------------------------

	/** A key while the sidebar has focus; false leaves it to the editor (ctrl chords and the like). */
	handleKey(data: string): boolean {
		const keys = getKeybindings();
		if (this.#query !== undefined && this.#handleFilterKey(data)) {
			this.#events.requestRender();
			return true;
		}
		if (keys.matches(data, "tui.select.up")) this.#move(-1);
		else if (keys.matches(data, "tui.select.down")) this.#move(1);
		else if (keys.matches(data, "tui.select.pageUp")) this.#move(-this.#pageRows);
		else if (keys.matches(data, "tui.select.pageDown")) this.#move(this.#pageRows);
		else if (keys.matches(data, "tui.select.confirm")) this.#open(this.#selectedSession());
		else if (keys.matches(data, "tui.select.cancel")) this.#events.onExit();
		else {
			const text = extractPrintableText(data);
			// Letters never fall through to the editor while the list has the keys.
			if (text === undefined) return false;
			if (text === "/") this.#setQuery("");
			else if (text === "n") this.#confirm(NEW_SESSION, () => this.#deps.newSession());
			else return true;
		}
		this.#events.requestRender();
		return true;
	}

	/** Filter editing; false lets the key act on the filtered list (arrows, enter). */
	#handleFilterKey(data: string): boolean {
		const keys = getKeybindings();
		const query = this.#query ?? "";
		if (keys.matches(data, "tui.select.cancel")) {
			this.#setQuery(undefined);
		} else if (keys.matches(data, "tui.editor.deleteCharBackward")) {
			this.#setQuery(query ? query.slice(0, -1) : undefined);
		} else {
			const text = extractPrintableText(data);
			if (text === undefined) return false;
			this.#setQuery(query + text);
		}
		return true;
	}

	#setQuery(query: string | undefined): void {
		this.#query = query;
		// The best match leads the filtered list; leaving the filter returns to the current session.
		this.#selected = undefined;
		this.#top = 0;
		this.#reveal = true;
	}

	/** The next frame scrolls the selection (the current session before any move) into view. */
	reveal(): void {
		this.#reveal = true;
	}

	/** Click on sidebar row `row` (0 = its top): open the session drawn there; header and hint rows do nothing. */
	click(row: number): void {
		const listRow = row - HEADER_ROWS;
		if (listRow < 0 || listRow >= this.#rows) return;
		const session = this.#list()[this.#top + listRow];
		if (!session) return;
		this.#selected = session.path;
		this.#open(session);
		this.#events.requestRender();
	}

	/** Wheel over the sidebar scrolls the list; the selection stays. */
	scroll(wheel: number): void {
		// Clamped now, not next frame: a click in the same input batch reads it.
		const last = Math.max(0, this.#list().length - this.#rows);
		this.#top = Math.min(last, Math.max(0, this.#top + wheel * WHEEL_STEP));
		this.#reveal = false;
		this.#events.requestRender();
	}

	get #pageRows(): number {
		return Math.max(1, this.#rows);
	}

	#move(delta: number): void {
		const list = this.#list();
		if (list.length === 0) return;
		const index = Math.min(list.length - 1, Math.max(0, this.#selectedIndex(list) + delta));
		this.#selected = list[index]!.path;
		this.#reveal = true;
	}

	#open(session: SidebarSession | undefined): void {
		if (!session) return;
		if (session.path === this.#deps.currentPath()) {
			this.#events.onExit();
			return;
		}
		this.#confirm(session.path, () => this.#deps.switchTo(session.path));
	}

	/** Leaving the session aborts a running turn: that takes a second confirm within {@link ABORT_CONFIRM_MS}. */
	#confirm(key: string, action: () => Promise<void>): void {
		if (this.#busy) return;
		const now = Date.now();
		const armed = this.#armed;
		if (this.#deps.isStreaming() && !(armed?.key === key && now < armed.until)) {
			this.#armed = { key, until: now + ABORT_CONFIRM_MS };
			return;
		}
		this.#armed = undefined;
		this.#busy = true;
		action()
			.then(
				() => this.#events.onSessionChanged(),
				err => logger.warn("Workbench failed to change the session", { error: String(err) }),
			)
			.finally(() => {
				this.#busy = false;
				void this.refresh();
			});
	}

	// --- Rendering --------------------------------------------------------------

	/** Exactly `height` rows, each at most `width` columns. */
	render(width: number, height: number, focused: boolean): string[] {
		const list = this.#list();
		const listRows = Math.max(0, height - HEADER_ROWS - FOOTER_ROWS);
		this.#rows = listRows;
		const selected = this.#selectedIndex(list);
		this.#clampTop(list.length, listRows, selected);

		const count = this.#query === undefined ? `${list.length}` : `${list.length}/${this.#sessions.length}`;
		const header = `${theme.bold(this.#deps.projectName())} ${theme.fg("dim", count)}`;
		const lines = [truncateToWidth(header, width), theme.fg("dim", "─".repeat(width))];
		const now = Date.now();
		const current = this.#deps.currentPath();
		for (let row = 0; row < listRows; row++) {
			const index = this.#top + row;
			const session = list[index];
			if (session)
				lines.push(this.#renderRow(session, width, now, session.path === current, focused && index === selected));
			else if (row === 0) lines.push(theme.fg("dim", this.#emptyText()));
			else lines.push("");
		}
		lines.push(truncateToWidth(this.#footer(now, focused), width));
		return lines.slice(0, height);
	}

	#renderRow(session: SidebarSession, width: number, now: number, current: boolean, selected: boolean): string {
		const time = relativeTime(session.modified, now);
		const marker = current ? this.#currentMarker() : " ";
		const nameWidth = Math.max(1, width - visibleWidth(marker) - 1 - 1 - visibleWidth(time));
		const name = truncateToWidth(session.displayName, nameWidth);
		const gap = padding(nameWidth - visibleWidth(name) + 1);
		if (selected) return theme.inverse(`${marker} ${name}${gap}${time}`);
		return `${current ? theme.fg("accent", marker) : marker} ${name}${gap}${theme.fg("dim", time)}`;
	}

	/** `●` on the current session; a spinner while its turn runs. */
	#currentMarker(): string {
		if (!this.#deps.isStreaming()) return "●";
		const frames = theme.spinnerFrames;
		return frames[Math.floor(performance.now() / SPINNER_ADVANCE_MS) % frames.length] ?? "●";
	}

	#emptyText(): string {
		if (!this.#loaded) return this.#loadFailed ? "会话列表加载失败" : "加载中…";
		return this.#query ? "无匹配会话" : "暂无会话";
	}

	#footer(now: number, focused: boolean): string {
		const armed = this.#armed;
		if (armed && now < armed.until) return theme.fg("warning", "再次确认将中止当前回合");
		if (this.#query !== undefined) return `${theme.fg("accent", "/")}${this.#query}`;
		if (focused) return theme.fg("dim", "/ 过滤  n 新建");
		// Unfocused, those keys go to the editor: name the key that focuses the list instead.
		const [key] = getKeybindings().getKeys("fork.workbench.sidebar");
		return key ? theme.fg("dim", `${key} 选择`) : "";
	}

	/** Keep the list window inside the list and, after a key move, around the selection. */
	#clampTop(length: number, rows: number, selected: number): void {
		if (this.#reveal && rows > 0) {
			this.#reveal = false;
			if (selected < this.#top) this.#top = selected;
			else if (selected >= this.#top + rows) this.#top = selected - rows + 1;
		}
		this.#top = Math.max(0, Math.min(this.#top, length - rows));
	}

	/** The shown entries: every session (the unlisted current one first), or the ranked matches while filtering. */
	#list(): readonly SidebarSession[] {
		const query = this.#query?.trim();
		if (this.#query === undefined) {
			const unlisted = this.#unlistedCurrent();
			return unlisted ? [unlisted, ...this.#sessions] : this.#sessions;
		}
		if (!query) return this.#sessions;
		const cached = this.#filtered;
		if (cached?.sessions === this.#sessions && cached.query === query) return cached.ranked;
		const ranked = rankSessionSearchMatches([...this.#sessions], query);
		this.#filtered = { sessions: this.#sessions, query, ranked };
		return ranked;
	}

	/**
	 * The listing leaves out sessions with no title and no message yet, so a new
	 * session would show no marker or spinner until its first turn is listed.
	 */
	#unlistedCurrent(): SidebarSession | undefined {
		const current = this.#deps.currentPath();
		if (!this.#loaded || current === undefined || this.#sessions.some(s => s.path === current)) return undefined;
		if (this.#unlisted?.path !== current) {
			this.#unlisted = {
				path: current,
				id: "",
				cwd: "",
				modified: new Date(Date.now()),
				size: 0,
				firstMessage: "",
				allMessagesText: "",
				displayName: "新会话",
			};
		}
		return this.#unlisted;
	}

	/** The selected entry; before any move, the current session (the best match while filtering). */
	#selectedIndex(list: readonly SidebarSession[]): number {
		const byPath = (path: string | undefined) => (path === undefined ? -1 : list.findIndex(s => s.path === path));
		const selected = byPath(this.#selected);
		if (selected !== -1) return selected;
		const current = this.#query === undefined ? byPath(this.#deps.currentPath()) : -1;
		return Math.max(0, current);
	}

	#selectedSession(): SidebarSession | undefined {
		const list = this.#list();
		return list[this.#selectedIndex(list)];
	}
}
