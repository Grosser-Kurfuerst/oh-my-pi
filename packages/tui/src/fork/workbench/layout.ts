/**
 * Pure geometry for the workbench shell: column and row allocation plus
 * hit-testing of 0-based screen coordinates.
 */

/** Rows the scrollable content area keeps even when the bottom chrome is tall. */
export const MIN_CONTENT_ROWS = 4;

export interface ColumnSpan {
	readonly x: number;
	readonly width: number;
}

export interface WorkbenchLayout {
	readonly columns: number;
	readonly rows: number;
	/** Main column: transcript content above, pinned chrome (editor, status) below. */
	readonly main: ColumnSpan;
	/** First screen row of the pinned bottom area; the content area spans `[0, bottomTop)`. */
	readonly bottomTop: number;
}

export type WorkbenchRegion = "content" | "bottom" | "outside";

/** Most rows the pinned bottom area may take on a screen `rows` tall. */
export function bottomRowCap(rows: number): number {
	return Math.max(0, rows - MIN_CONTENT_ROWS);
}

/**
 * Keep the bottom chrome within {@link bottomRowCap}. The tail survives: the
 * cursor row and a selector's highlighted entry sit near the bottom.
 */
export function clampBottomRows(lines: readonly string[], rows: number): readonly string[] {
	const cap = bottomRowCap(rows);
	return lines.length > cap ? lines.slice(lines.length - cap) : lines;
}

/** Main column span; independent of row allocation so chrome can render at its width first. */
export function mainColumn(columns: number): ColumnSpan {
	return { x: 0, width: Math.max(1, columns) };
}

export function computeLayout(columns: number, rows: number, bottomRows: number): WorkbenchLayout {
	const safeRows = Math.max(0, rows);
	const bottom = Math.min(Math.max(0, bottomRows), bottomRowCap(safeRows));
	return {
		columns: Math.max(1, columns),
		rows: safeRows,
		main: mainColumn(columns),
		bottomTop: safeRows - bottom,
	};
}

export function regionAt(layout: WorkbenchLayout, row: number, col: number): WorkbenchRegion {
	if (row < 0 || row >= layout.rows) return "outside";
	if (col < layout.main.x || col >= layout.main.x + layout.main.width) return "outside";
	return row < layout.bottomTop ? "content" : "bottom";
}
