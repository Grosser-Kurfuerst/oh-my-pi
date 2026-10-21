import { describe, expect, it } from "bun:test";
import {
	highlightRow,
	LINE_END,
	MouseSelection,
	orderRange,
	selectedText,
	wordRange,
} from "@oh-my-pi/pi-tui/fork/workbench/selection";
import { replaceTabs } from "@oh-my-pi/pi-tui/utils";

// Rendered rows as components emit them: styled, padded, CJK wide characters, a tab.
const rows = ["\x1b[31mab中文cd\x1b[0m tail   ", "\x1b[1mline \x1b[38;5;75mtwo\x1b[39m\x1b[22m", "第三行\tend", ""];

describe("selection text", () => {
	it("copies a reversed multi-row drag as plain text, keeping wide characters whole", () => {
		// Starts on the right half of 中 (columns 2-3), ends on the right half of 三 (columns 2-3).
		const range = orderRange({ row: 2, col: 3 }, { row: 0, col: 3 });
		expect(selectedText(rows, range)).toBe("中文cd tail\nline two\n第三");
	});

	it("expands tabs and keeps blank rows inside the range", () => {
		const range = orderRange({ row: 2, col: 0 }, { row: 3, col: LINE_END });
		expect(selectedText(rows, range)).toBe(`${replaceTabs("第三行\tend")}\n`);
	});

	it("picks a letter run, a single CJK character, or a lone punctuation mark as the word", () => {
		const line = "\x1b[2mhello, 世界 foo_bar\x1b[22m";
		const word = (col: number) => selectedText([line], wordRange(line, 0, col)!);
		expect(word(2)).toBe("hello");
		expect(word(5)).toBe(",");
		// 世 spans columns 7-8; its right half picks it alone.
		expect(word(8)).toBe("世");
		expect(word(17)).toBe("foo_bar");
		expect(wordRange(line, 0, 40)).toBeUndefined();
	});
});

describe("selection highlight", () => {
	it("reverses whole wide characters and keeps the styling around them", () => {
		const line = "\x1b[31mab中文cd\x1b[0m tail";
		// Columns 3-4 cut 中 and 文 in half; both are highlighted whole.
		const out = highlightRow(line, 3, 5);
		expect(Bun.stripANSI(out)).toBe(Bun.stripANSI(line));
		expect(out).toContain("\x1b[7m中文\x1b[27m");
		// The text after the highlight keeps its own red.
		const after = out.slice(out.indexOf("\x1b[27m") + "\x1b[27m".length);
		expect(after.startsWith("\x1b[31m")).toBe(true);
		expect(Bun.stripANSI(after)).toBe("cd tail");
	});
});

describe("mouse selection", () => {
	const line = "hello world";

	it("selects nothing for a click that never moved", () => {
		const selection = new MouseSelection();
		selection.press({ row: 0, col: 2 }, line, 0);
		selection.drag({ row: 0, col: 2 });
		expect(selection.release()).toBeUndefined();
	});

	it("cycles word and line picks on repeated presses of one cell, and starts over after the window", () => {
		const selection = new MouseSelection();
		const press = (at: number) => {
			selection.press({ row: 0, col: 7 }, line, at);
			return selection.release();
		};
		press(0);
		expect(press(100)).toEqual({ start: { row: 0, col: 6 }, end: { row: 0, col: 10 } });
		expect(press(200)).toEqual({ start: { row: 0, col: 0 }, end: { row: 0, col: LINE_END } });
		expect(press(1000)).toBeUndefined();
	});
});
