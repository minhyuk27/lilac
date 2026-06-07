import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import type LilacPlugin from "../main";
import { Category, ScheduleItem } from "./types";
import { addDays, isSameDay, startOfWeek, toISO, parseISO } from "./dates";
import { expandOccurrences } from "./recurrence";
import { openDailyNote } from "./daily-note";

export const VIEW_TYPE_CALENDAR = "lilac-calendar";

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
const GRID_WEEKS = 6;
const REFERENCE_ROW = 1; // SPEC §3.1: 현재 주를 항상 2번째 줄(= index 1)에 고정

type BandPosition = "single" | "start" | "middle" | "end";

interface DayEntry {
	item: ScheduleItem;
	category: Category | null;
	bandPosition: BandPosition;
}

export class LilacCalendarView extends ItemView {
	private referenceWeekStart: Date;

	constructor(leaf: WorkspaceLeaf, private plugin: LilacPlugin) {
		super(leaf);
		this.referenceWeekStart = startOfWeek(new Date());
	}

	getViewType(): string {
		return VIEW_TYPE_CALENDAR;
	}

	getDisplayText(): string {
		return "Lilac 캘린더";
	}

	getIcon(): string {
		return "calendar-days";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	/** Re-render in place — called by the plugin after the index changes underneath us. */
	refresh(): void {
		if (this.contentEl.isShown()) this.render();
	}

	private gridStart(): Date {
		return addDays(this.referenceWeekStart, -7);
	}

	private shiftWeeks(n: number): void {
		this.referenceWeekStart = addDays(this.referenceWeekStart, n * 7);
		this.render();
	}

	private goToToday(): void {
		this.referenceWeekStart = startOfWeek(new Date());
		this.render();
	}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("lilac-calendar");

		this.renderHeader(container);
		this.renderGrid(container);
	}

	private renderHeader(container: HTMLElement): void {
		const header = container.createDiv({ cls: "lilac-calendar-header" });

		const nav = header.createDiv({ cls: "lilac-calendar-nav" });
		nav.createEl("button", { cls: "lilac-nav-btn", text: "‹" }).onclick = () => this.shiftWeeks(-1);
		nav.createEl("button", { cls: "lilac-nav-btn lilac-today-btn", text: "오늘" }).onclick = () => this.goToToday();
		nav.createEl("button", { cls: "lilac-nav-btn", text: "›" }).onclick = () => this.shiftWeeks(1);

		const gridStart = this.gridStart();
		const gridEnd = addDays(gridStart, GRID_WEEKS * 7 - 1);
		header.createDiv({ cls: "lilac-calendar-label", text: this.formatRangeLabel(gridStart, gridEnd) });
	}

	private formatRangeLabel(start: Date, end: Date): string {
		const sameYear = start.getFullYear() === end.getFullYear();
		const sameMonth = sameYear && start.getMonth() === end.getMonth();
		if (sameMonth) return `${start.getFullYear()}년 ${start.getMonth() + 1}월`;
		if (sameYear) return `${start.getFullYear()}년 ${start.getMonth() + 1}월 – ${end.getMonth() + 1}월`;
		return `${start.getFullYear()}.${start.getMonth() + 1} – ${end.getFullYear()}.${end.getMonth() + 1}`;
	}

	private renderGrid(container: HTMLElement): void {
		const grid = container.createDiv({ cls: "lilac-calendar-grid" });

		const weekdayRow = grid.createDiv({ cls: "lilac-calendar-row lilac-calendar-weekdays" });
		WEEKDAY_LABELS.forEach((label, i) => {
			const cell = weekdayRow.createDiv({ cls: "lilac-calendar-weekday", text: label });
			if (i === 0) cell.addClass("lilac-sunday");
			if (i === 6) cell.addClass("lilac-saturday");
		});

		const gridStart = this.gridStart();
		const gridEnd = addDays(gridStart, GRID_WEEKS * 7 - 1);
		const db = this.plugin.getDatabase();
		const items = db?.getScheduleItemsOverlapping(toISO(gridStart), toISO(gridEnd)) ?? [];
		const categoryById = new Map((db?.getCategories() ?? []).map((c) => [c.id, c]));
		const entriesByDate = this.buildEntriesByDate(items, categoryById, gridStart, gridEnd);

		const today = new Date();

		for (let week = 0; week < GRID_WEEKS; week++) {
			const row = grid.createDiv({ cls: "lilac-calendar-row" });
			if (week === REFERENCE_ROW) row.addClass("lilac-reference-week");

			for (let day = 0; day < 7; day++) {
				const date = addDays(gridStart, week * 7 + day);
				const iso = toISO(date);
				const cell = row.createDiv({ cls: "lilac-calendar-cell" });
				if (day === 0) cell.addClass("lilac-sunday");
				if (day === 6) cell.addClass("lilac-saturday");
				if (isSameDay(date, today)) cell.addClass("lilac-today");

				const dateLabel = cell.createDiv({ cls: "lilac-cell-date", text: String(date.getDate()) });
				dateLabel.onclick = () => void openDailyNote(this.app, date);

				const entryList = cell.createDiv({ cls: "lilac-cell-entries" });
				for (const entry of entriesByDate.get(iso) ?? []) {
					this.renderChip(entryList, entry);
				}
			}
		}
	}

	private buildEntriesByDate(
		items: ScheduleItem[],
		categoryById: Map<string, Category>,
		gridStart: Date,
		gridEnd: Date
	): Map<string, DayEntry[]> {
		const gridStartISO = toISO(gridStart);
		const gridEndISO = toISO(gridEnd);
		const map = new Map<string, DayEntry[]>();

		const push = (iso: string, entry: DayEntry) => {
			if (iso < gridStartISO || iso > gridEndISO) return;
			const list = map.get(iso);
			if (list) list.push(entry);
			else map.set(iso, [entry]);
		};

		for (const item of items) {
			const category = item.category ? categoryById.get(item.category) ?? null : null;
			if (!this.isVisible(item, category)) continue;

			if (item.recurrence && item.start) {
				for (const iso of expandOccurrences(item.recurrence, item.start, gridStartISO, gridEndISO)) {
					push(iso, { item, category, bandPosition: "single" });
				}
				continue;
			}

			if (item.schedule_kind === "period" && item.start) {
				const itemStart = item.start;
				const itemEnd = item.end ?? item.start;
				const rangeStart = itemStart > gridStartISO ? itemStart : gridStartISO;
				const rangeEnd = itemEnd < gridEndISO ? itemEnd : gridEndISO;

				let cursor = parseISO(rangeStart);
				const endDate = parseISO(rangeEnd);
				while (cursor <= endDate) {
					const iso = toISO(cursor);
					const position: BandPosition =
						iso === itemStart && iso === itemEnd ? "single" : iso === itemStart ? "start" : iso === itemEnd ? "end" : "middle";
					push(iso, { item, category, bandPosition: position });
					cursor = addDays(cursor, 1);
				}
			} else if (item.start) {
				push(item.start, { item, category, bandPosition: "single" });
			}
		}

		for (const list of map.values()) {
			list.sort((a, b) => (a.item.time_start ?? "").localeCompare(b.item.time_start ?? "") || a.item.title.localeCompare(b.item.title));
		}
		return map;
	}

	private isVisible(item: ScheduleItem, category: Category | null): boolean {
		if (item.calendar_visible !== null) return item.calendar_visible;
		if (category) return category.calendar_visible;
		return true;
	}

	private renderChip(container: HTMLElement, entry: DayEntry): void {
		const { item, category, bandPosition } = entry;
		const chip = container.createDiv({ cls: `lilac-chip lilac-chip-${bandPosition}` });
		if (category) chip.style.setProperty("--lilac-chip-color", category.color);

		const label = item.schedule_kind === "time" && item.time_start ? `${item.time_start} ${item.title}` : item.title;
		chip.setText(label);
		chip.onclick = () => void this.openItemTarget(item);
	}

	private async openItemTarget(item: ScheduleItem): Promise<void> {
		const linkpath = item.link ? this.extractLinkpath(item.link) : item.path;
		const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, item.path) ?? this.app.vault.getAbstractFileByPath(item.path);
		if (dest instanceof TFile) await this.app.workspace.getLeaf(false).openFile(dest);
	}

	/** "[[folder/note|alias]]" -> "folder/note"; plain paths pass through untouched. */
	private extractLinkpath(link: string): string {
		const match = link.match(/\[\[([^\]|]+)/);
		return match ? match[1].trim() : link;
	}
}
