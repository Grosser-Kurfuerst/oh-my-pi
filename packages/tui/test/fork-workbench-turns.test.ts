import { beforeAll, describe, expect, it } from "bun:test";
import { nearestTurn, railRow, renderRail } from "@oh-my-pi/pi-tui/fork/workbench/rail";
import {
	currentTurn,
	jumpOffset,
	type TurnEntry,
	turnLabel,
	turnTarget,
} from "@oh-my-pi/pi-tui/fork/workbench/turn-index";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";

const turns: TurnEntry[] = [
	{ row: 0, label: "first" },
	{ row: 10, label: "second" },
	{ row: 40, label: "third" },
];

beforeAll(async () => {
	await initTheme();
});

describe("turn jumps", () => {
	it("goes back to the prompt of the turn being read before the turn above it", () => {
		// Mid-answer of the second turn: back lands on its own prompt…
		expect(turnTarget(turns, 25, -1)).toBe(1);
		// …and from there on the first one.
		expect(turnTarget(turns, jumpOffset(turns[1]!), -1)).toBe(0);
		expect(currentTurn(turns, jumpOffset(turns[1]!))).toBe(1);
	});

	it("reports no target past either end", () => {
		expect(turnTarget(turns, jumpOffset(turns[0]!), -1)).toBeUndefined();
		expect(turnTarget([], 0, -1)).toBeUndefined();
		expect(turnTarget(turns, jumpOffset(turns[2]!), 1)).toBeUndefined();
		expect(turnTarget(turns, 0, 1)).toBe(1);
	});

	it("labels a prompt with its first visible line, without styling or tabs", () => {
		expect(turnLabel(["\x1b[48;5;236m      \x1b[0m", "\x1b[48;5;236m  fix\tthe bug \x1b[0m"])).toMatch(
			/^fix +the bug$/,
		);
	});
});

describe("turn rail", () => {
	it("maps rows monotonically into the rail height", () => {
		const rows = [0, 1, 5, 49, 50, 99];
		const mapped = rows.map(row => railRow(row, 10, 100));
		expect(mapped).toEqual([0, 0, 0, 4, 5, 9]);
	});

	it("merges ticks that share a row and accents the current turn", () => {
		const crowded: TurnEntry[] = [
			{ row: 0, label: "a" },
			{ row: 2, label: "b" },
			{ row: 60, label: "c" },
		];
		const cells = renderRail(crowded, 5, 100, { start: 20, end: 60 }, 1);
		expect(cells.map(cell => Bun.stripANSI(cell))).toEqual(["━", "┃", "┃", "━", "│"]);
		expect(cells[0]).toBe(theme.fg("accent", "━"));
	});

	it("picks the nearest tick on click, the earlier one on a tie", () => {
		expect(nearestTurn(turns, 10, 50, 0)).toBe(0);
		expect(nearestTurn(turns, 10, 50, 1)).toBe(0);
		expect(nearestTurn(turns, 10, 50, 2)).toBe(1);
		expect(nearestTurn(turns, 10, 50, 9)).toBe(2);
		expect(nearestTurn([], 10, 50, 3)).toBeUndefined();
	});
});
