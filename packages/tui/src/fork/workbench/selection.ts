/**
 * Mouse selection over the workbench content buffer. Points are logical
 * content rows and display columns, so a selection survives scrolling. Text is
 * extracted from the rendered rows: styling dropped, tabs expanded, wide
 * characters kept whole, trailing spaces trimmed.
 */
import {
	getSegmenter,
	getWordNavKind,
	replaceTabs,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "../../utils";

export interface CellPoint {
	readonly row: number;
	readonly col: number;
}

/** Inclusive on both ends, `start` before `end` in reading order. */
export interface CellRange {
	readonly start: CellPoint;
	readonly end: CellPoint;
}

/** Column past any row's end; selects to the end of the line. */
export const LINE_END = Number.MAX_SAFE_INTEGER;

interface Cell {
	readonly text: string;
	readonly col: number;
	readonly width: number;
}

/** Plain text of a rendered row, one entry per grapheme with its column span. */
function cellsOf(line: string): Cell[] {
	const cells: Cell[] = [];
	let col = 0;
	for (const { segment } of getSegmenter().segment(replaceTabs(stripTerminalSequences(line)))) {
		const width = visibleWidth(segment);
		cells.push({ text: segment, col, width });
		col += width;
	}
	return cells;
}

/** Cells overlapping columns `[from, to)`; a wide character half inside counts as inside. */
function cellsIn(cells: readonly Cell[], from: number, to: number): Cell[] {
	return cells.filter(cell => cell.col < to && cell.col + Math.max(1, cell.width) > from);
}

export function orderRange(a: CellPoint, b: CellPoint): CellRange {
	const aFirst = a.row < b.row || (a.row === b.row && a.col <= b.col);
	return aFirst ? { start: a, end: b } : { start: b, end: a };
}

/** Columns `[from, to)` the range covers on `row`, or undefined when it misses the row. */
export function rowSpan(range: CellRange, row: number): readonly [number, number] | undefined {
	if (row < range.start.row || row > range.end.row) return undefined;
	const from = row === range.start.row ? range.start.col : 0;
	const to = row === range.end.row ? range.end.col + 1 : LINE_END;
	return [from, to];
}

/** The selected text: one line per row, trailing spaces trimmed. */
export function selectedText(rows: readonly string[], range: CellRange): string {
	const lines: string[] = [];
	for (let row = range.start.row; row <= range.end.row && row < rows.length; row++) {
		const [from, to] = rowSpan(range, row)!;
		const text = cellsIn(cellsOf(rows[row]!), from, to)
			.map(cell => cell.text)
			.join("");
		lines.push(text.trimEnd());
	}
	return lines.join("\n");
}

/** The word under `col` (a CJK character, a letter/digit run, or the single other character there). */
export function wordRange(line: string, row: number, col: number): CellRange | undefined {
	const cells = cellsOf(line);
	const index = cells.findIndex(cell => col >= cell.col && col < cell.col + Math.max(1, cell.width));
	if (index === -1) return undefined;
	let first = index;
	let last = index;
	// CJK characters are words of their own ("cjk", not "word"): there is no space between them to split on.
	const isWord = (cell: Cell) => getWordNavKind(cell.text) === "word";
	if (isWord(cells[index]!)) {
		while (first > 0 && isWord(cells[first - 1]!)) first--;
		while (last < cells.length - 1 && isWord(cells[last + 1]!)) last++;
	}
	const end = cells[last]!;
	return {
		start: { row, col: cells[first]!.col },
		end: { row, col: end.col + Math.max(1, end.width) - 1 },
	};
}

export function lineRange(row: number): CellRange {
	return { start: { row, col: 0 }, end: { row, col: LINE_END } };
}

/** Plain text of whole rows `[from, to)`, blank rows at either end dropped. */
export function rowsText(rows: readonly string[], from: number, to: number): string {
	if (to <= from) return "";
	const text = selectedText(rows, { start: { row: from, col: 0 }, end: { row: to - 1, col: LINE_END } });
	return text.replace(/^\n+|\n+$/g, "");
}

/** Presses on the same cell this close together count as a double or triple click. */
const MULTI_CLICK_MS = 400;

function samePoint(a: CellPoint, b: CellPoint): boolean {
	return a.row === b.row && a.col === b.col;
}

/**
 * Press/drag/release state: `idle → pressed(anchor) → dragging(anchor, head)
 * → idle`. A double click picks the word, a triple click the line; those
 * ranges are fixed and do not grow with the pointer.
 */
export class MouseSelection {
	/** The highlighted range; survives release until cleared. */
	#range: CellRange | undefined;
	/** Where a drag started; undefined when the press picked a word or line. */
	#anchor: CellPoint | undefined;
	#held = false;
	#lastPress: { readonly point: CellPoint; readonly at: number; readonly count: number } | undefined;

	get range(): CellRange | undefined {
		return this.#range;
	}

	/** The left button is down since a press in the content. */
	get isHeld(): boolean {
		return this.#held;
	}

	/** Held after a single press, so moving the pointer grows the range (a word or line pick does not). */
	get isExtending(): boolean {
		return this.#held && this.#anchor !== undefined;
	}

	/** Left press on `point` of the rendered row `line`, at time `now` (ms). */
	press(point: CellPoint, line: string, now: number): void {
		const last = this.#lastPress;
		const repeat = last !== undefined && now - last.at <= MULTI_CLICK_MS && samePoint(last.point, point);
		const count = repeat ? (last.count % 3) + 1 : 1;
		this.#lastPress = { point, at: now, count };
		this.#held = true;
		this.#anchor = count === 1 ? point : undefined;
		if (count === 1) this.#range = undefined;
		else if (count === 2) this.#range = wordRange(line, point.row, point.col);
		else this.#range = lineRange(point.row);
	}

	/** Pointer moved to `point` with the button held; a press that never moved selects nothing. */
	drag(point: CellPoint): void {
		const anchor = this.#anchor;
		if (!this.#held || !anchor) return;
		if (!this.#range && samePoint(anchor, point)) return;
		this.#range = orderRange(anchor, point);
	}

	/** Button released; returns the range to copy, if any. */
	release(): CellRange | undefined {
		if (!this.#held) return undefined;
		this.#held = false;
		this.#anchor = undefined;
		return this.#range;
	}

	clear(): void {
		this.#range = undefined;
		this.#anchor = undefined;
		this.#held = false;
	}
}

/** Repaint columns `[from, to)` of a rendered row in reverse video, widened to whole characters. */
export function highlightRow(line: string, from: number, to: number): string {
	const covered = cellsIn(cellsOf(line), from, to);
	if (covered.length === 0) return line;
	const start = covered[0]!.col;
	const last = covered.at(-1)!;
	const end = last.col + last.width;
	const text = covered.map(cell => cell.text).join("");
	return `${sliceByColumn(line, 0, start, true)}\x1b[0m\x1b[7m${text}\x1b[27m${sliceByColumn(line, end, LINE_END, true)}`;
}
