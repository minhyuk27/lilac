import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import type LilacPlugin from "../main";
import { Category, ScheduleItem, TodoItem } from "./types";
import { addDays, isSameDay, startOfWeek, toISO, parseISO, todayISO } from "./dates";
import { expandOccurrences } from "./recurrence";
import { openDailyNote } from "./daily-note";

export const VIEW_TYPE_CALENDAR = "lilac-calendar";

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
const GRID_WEEKS = 6;
const REFERENCE_ROW = 1; // SPEC §3.1: 현재 주를 항상 2번째 줄(= index 1)에 고정

/** A schedule occurrence clipped to the visible grid. Multi-day -> rendered as a band; single-day -> a chip. */
interface Occurrence {
	item: ScheduleItem;
	category: Category | null;
	startISO: string;
	endISO: string;
}

interface BandPlacement extends Occurrence {
	startCol: number; // 0-6, column within its week
	endCol: number; // 0-6 inclusive
	lane: number;
}

type ChipEntry =
	| { kind: "schedule"; item: ScheduleItem; category: Category | null }
	| { kind: "todo"; item: TodoItem; category: Category | null };

export class LilacCalendarView extends ItemView {
	private referenceWeekStart: Date;
	private selectedDateISO: string;

	constructor(leaf: WorkspaceLeaf, private plugin: LilacPlugin) {
		super(leaf);
		this.referenceWeekStart = startOfWeek(new Date());
		this.selectedDateISO = todayISO();
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

		const gridStart = this.gridStart();
		const gridEnd = addDays(gridStart, GRID_WEEKS * 7 - 1);
		const gridStartISO = toISO(gridStart);
		const gridEndISO = toISO(gridEnd);

		const db = this.plugin.getDatabase();
		const categoryById = new Map((db?.getCategories() ?? []).map((c) => [c.id, c]));
		const occurrences = this.buildOccurrences(
			db?.getScheduleItemsOverlapping(gridStartISO, gridEndISO) ?? [],
			categoryById,
			gridStartISO,
			gridEndISO
		);
		const todos = (db?.getTodoItemsInRange(gridStartISO, gridEndISO) ?? []).filter((t) =>
			this.isCategoryVisible(t.category ? categoryById.get(t.category) ?? null : null)
		);

		this.renderHeader(container, gridStart, gridEnd);
		this.renderGrid(container, gridStart, occurrences, todos);
		this.renderDayDetail(container, occurrences, todos);
	}

	private renderHeader(container: HTMLElement, gridStart: Date, gridEnd: Date): void {
		const header = container.createDiv({ cls: "lilac-calendar-header" });

		const nav = header.createDiv({ cls: "lilac-calendar-nav" });
		// Up/down: a "rolling" week grid scrolls vertically through time, not sideways through months.
		nav.createEl("button", { cls: "lilac-nav-btn", text: "▲" }).onclick = () => this.shiftWeeks(-1);
		nav.createEl("button", { cls: "lilac-nav-btn lilac-today-btn", text: "오늘" }).onclick = () => this.goToToday();
		nav.createEl("button", { cls: "lilac-nav-btn", text: "▼" }).onclick = () => this.shiftWeeks(1);

		header.createDiv({ cls: "lilac-calendar-label", text: this.formatRangeLabel(gridStart, gridEnd) });
	}

	private formatRangeLabel(start: Date, end: Date): string {
		const sameYear = start.getFullYear() === end.getFullYear();
		const sameMonth = sameYear && start.getMonth() === end.getMonth();
		if (sameMonth) return `${start.getFullYear()}년 ${start.getMonth() + 1}월`;
		if (sameYear) return `${start.getFullYear()}년 ${start.getMonth() + 1}월 – ${end.getMonth() + 1}월`;
		return `${start.getFullYear()}.${start.getMonth() + 1} – ${end.getFullYear()}.${end.getMonth() + 1}`;
	}

	private renderGrid(container: HTMLElement, gridStart: Date, occurrences: Occurrence[], todos: TodoItem[]): void {
		const grid = container.createDiv({ cls: "lilac-calendar-grid" });

		const weekdayRow = grid.createDiv({ cls: "lilac-calendar-weekdays" });
		WEEKDAY_LABELS.forEach((label, i) => {
			const cell = weekdayRow.createDiv({ cls: "lilac-calendar-weekday", text: label });
			if (i === 0) cell.addClass("lilac-sunday");
			if (i === 6) cell.addClass("lilac-saturday");
		});

		const today = new Date();

		for (let week = 0; week < GRID_WEEKS; week++) {
			const weekStart = addDays(gridStart, week * 7);
			const weekStartISO = toISO(weekStart);
			const weekEndISO = toISO(addDays(weekStart, 6));

			const bands = this.placeBands(occurrences, weekStart, weekStartISO, weekEndISO);
			const laneCount = Math.max(0, ...bands.map((b) => b.lane + 1));

			const weekEl = grid.createDiv({ cls: "lilac-calendar-week" });
			if (week === REFERENCE_ROW) weekEl.addClass("lilac-reference-week");
			// CSS custom properties can't drive repeat()'s count, so build the track list directly:
			// one fixed-height row per band lane, then a flexible row for the day cells.
			weekEl.style.gridTemplateRows = `${"1.4em ".repeat(laneCount)}minmax(5em, 1fr)`;

			for (const band of bands) {
				const el = weekEl.createDiv({ cls: "lilac-band" });
				el.style.gridColumn = `${band.startCol + 1} / ${band.endCol + 2}`;
				el.style.gridRow = `${band.lane + 1}`;
				if (band.category) el.style.setProperty("--lilac-chip-color", band.category.color);
				el.setText(band.item.title);
				el.onclick = (e) => {
					e.stopPropagation();
					void this.openItemTarget(band.item);
				};
			}

			const chipsByCol = this.collectDayChips(occurrences, todos, weekStart);

			for (let day = 0; day < 7; day++) {
				const date = addDays(weekStart, day);
				const dateISO = toISO(date);
				const cell = weekEl.createDiv({ cls: "lilac-calendar-cell" });
				cell.style.gridColumn = `${day + 1}`;
				cell.style.gridRow = `${laneCount + 1}`;
				if (day === 0) cell.addClass("lilac-sunday");
				if (day === 6) cell.addClass("lilac-saturday");
				if (isSameDay(date, today)) cell.addClass("lilac-today");
				if (dateISO === this.selectedDateISO) cell.addClass("lilac-selected");
				// Tapping the cell selects the day (-> full agenda below); the date number opens the daily note.
				cell.onclick = () => this.selectDate(dateISO);

				const dateLabel = cell.createDiv({ cls: "lilac-cell-date", text: this.formatDateLabel(date) });
				if (date.getDate() === 1) dateLabel.addClass("lilac-month-start");
				dateLabel.onclick = (e) => {
					e.stopPropagation();
					void openDailyNote(this.app, date);
				};

				const entryList = cell.createDiv({ cls: "lilac-cell-entries" });
				for (const entry of chipsByCol.get(day) ?? []) {
					this.renderChip(entryList, entry);
				}
			}
		}
	}

	private selectDate(dateISO: string): void {
		if (this.selectedDateISO === dateISO) return;
		this.selectedDateISO = dateISO;
		this.render();
	}

	/**
	 * Full-text agenda for the selected day — mirrors how Google/Samsung Calendar show a day's
	 * events below the month grid. The grid cells are too narrow on mobile to show full titles
	 * (see lilac STATE — "아이콘만 보이고 내용이 안 보여"), so this panel is the place that
	 * always shows complete information regardless of screen width.
	 */
	private renderDayDetail(container: HTMLElement, occurrences: Occurrence[], todos: TodoItem[]): void {
		const dateISO = this.selectedDateISO;
		const date = parseISO(dateISO);
		const panel = container.createDiv({ cls: "lilac-day-detail" });

		const header = panel.createDiv({ cls: "lilac-day-detail-header" });
		const label = header.createDiv({ cls: "lilac-day-detail-date", text: this.formatFullDateLabel(date) });
		label.onclick = () => void openDailyNote(this.app, date);

		const list = panel.createDiv({ cls: "lilac-day-detail-list" });
		const dayOccurrences = occurrences.filter((o) => dateISO >= o.startISO && dateISO <= o.endISO);
		const dayTodos = todos.filter((t) => t.due === dateISO || t.do_date === dateISO);

		if (dayOccurrences.length === 0 && dayTodos.length === 0) {
			list.createDiv({ cls: "lilac-day-detail-empty", text: "일정이 없습니다" });
			return;
		}

		type Row = { sortKey: string; render: (parent: HTMLElement) => void };
		const rows: Row[] = [];

		for (const occ of dayOccurrences) {
			rows.push({
				sortKey: `0_${occ.item.time_start ?? ""}_${occ.item.title}`,
				render: (parent) => {
					const row = parent.createDiv({ cls: "lilac-detail-row" });
					const dot = row.createDiv({ cls: "lilac-detail-dot" });
					if (occ.category) dot.style.setProperty("--lilac-chip-color", occ.category.color);
					const text = row.createDiv({ cls: "lilac-detail-text" });
					const timeLabel =
						occ.item.schedule_kind === "time" && occ.item.time_start
							? occ.item.time_start + (occ.item.time_end ? `–${occ.item.time_end}` : "")
							: occ.item.schedule_kind === "period" && occ.startISO !== occ.endISO
							? "기간 일정"
							: "종일";
					text.createSpan({ cls: "lilac-detail-time", text: timeLabel });
					text.createSpan({ cls: "lilac-detail-title", text: occ.item.title });
					row.onclick = () => void this.openItemTarget(occ.item);
				},
			});
		}

		for (const todo of dayTodos) {
			rows.push({
				sortKey: `1_${todo.title}`,
				render: (parent) => {
					const row = parent.createDiv({ cls: "lilac-detail-row lilac-detail-row-todo" });
					row.createDiv({ cls: "lilac-detail-marker", text: todo.do_date === dateISO ? "▸" : "⏰" });
					const text = row.createDiv({ cls: "lilac-detail-text" });
					text.createSpan({ cls: "lilac-detail-time", text: todo.do_date === dateISO ? "실행 예정" : "마감" });
					text.createSpan({ cls: "lilac-detail-title", text: todo.title });
					row.onclick = () => void this.openItemTarget(todo);
				},
			});
		}

		rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
		for (const row of rows) row.render(list);
	}

	/** "7월 9일 (목)" — the day-detail panel has room for the full label, no abbreviation needed. */
	private formatFullDateLabel(date: Date): string {
		return `${date.getMonth() + 1}월 ${date.getDate()}일 (${WEEKDAY_LABELS[date.getDay()]})`;
	}

	/** "7" normally, but "6/1" on the 1st of a month — marks month boundaries in the rolling grid. */
	private formatDateLabel(date: Date): string {
		return date.getDate() === 1 ? `${date.getMonth() + 1}/${date.getDate()}` : String(date.getDate());
	}

	private buildOccurrences(
		items: ScheduleItem[],
		categoryById: Map<string, Category>,
		gridStartISO: string,
		gridEndISO: string
	): Occurrence[] {
		const occurrences: Occurrence[] = [];

		for (const item of items) {
			const category = item.category ? categoryById.get(item.category) ?? null : null;
			if (!this.isVisible(item, category)) continue;

			if (item.recurrence && item.start) {
				for (const iso of expandOccurrences(item.recurrence, item.start, gridStartISO, gridEndISO)) {
					occurrences.push({ item, category, startISO: iso, endISO: iso });
				}
				continue;
			}

			if (item.schedule_kind === "period" && item.start) {
				const itemStart = item.start;
				const itemEnd = item.end ?? item.start;
				const startISO = itemStart > gridStartISO ? itemStart : gridStartISO;
				const endISO = itemEnd < gridEndISO ? itemEnd : gridEndISO;
				if (startISO <= endISO) occurrences.push({ item, category, startISO, endISO });
			} else if (item.start) {
				occurrences.push({ item, category, startISO: item.start, endISO: item.start });
			}
		}
		return occurrences;
	}

	/** Multi-day occurrences within this week, packed into non-overlapping lanes (greedy interval packing). */
	private placeBands(occurrences: Occurrence[], weekStart: Date, weekStartISO: string, weekEndISO: string): BandPlacement[] {
		const spanning = occurrences
			.filter((o) => o.startISO !== o.endISO && o.endISO >= weekStartISO && o.startISO <= weekEndISO)
			.map((o) => {
				const startCol = Math.max(0, this.dayOffset(weekStart, o.startISO));
				const endCol = Math.min(6, this.dayOffset(weekStart, o.endISO));
				return { ...o, startCol, endCol, lane: 0 };
			})
			.sort((a, b) => a.startCol - b.startCol || b.endCol - a.endCol);

		const laneEnds: number[] = [];
		for (const band of spanning) {
			let lane = laneEnds.findIndex((end) => end < band.startCol);
			if (lane === -1) lane = laneEnds.length;
			laneEnds[lane] = band.endCol;
			band.lane = lane;
		}
		return spanning;
	}

	/** Single-day schedule occurrences + todos for this week, grouped by weekday column (0=Sun..6=Sat). */
	private collectDayChips(occurrences: Occurrence[], todos: TodoItem[], weekStart: Date): Map<number, ChipEntry[]> {
		const map = new Map<number, ChipEntry[]>();
		const push = (col: number, entry: ChipEntry) => {
			const list = map.get(col);
			if (list) list.push(entry);
			else map.set(col, [entry]);
		};

		for (const occ of occurrences) {
			if (occ.startISO !== occ.endISO) continue; // bands handled separately
			const col = this.dayOffset(weekStart, occ.startISO);
			if (col >= 0 && col <= 6) push(col, { kind: "schedule", item: occ.item, category: occ.category });
		}

		for (const todo of todos) {
			const dateISO = todo.do_date ?? todo.due;
			if (!dateISO) continue;
			const col = this.dayOffset(weekStart, dateISO);
			if (col >= 0 && col <= 6) push(col, { kind: "todo", item: todo, category: null });
		}

		for (const list of map.values()) {
			list.sort((a, b) => this.chipSortKey(a).localeCompare(this.chipSortKey(b)));
		}
		return map;
	}

	private chipSortKey(entry: ChipEntry): string {
		const time = entry.kind === "schedule" ? entry.item.time_start ?? "" : "";
		return `${time}_${entry.item.title}`;
	}

	private dayOffset(weekStart: Date, iso: string): number {
		// weekStart carries whatever time-of-day `new Date()` had when the view was opened
		// (addDays preserves it), while parseISO(iso) is always midnight. Diffing the two
		// directly leaves a leftover of up to ~24h, and Math.round lands on the wrong day
		// once that leftover passes 12h — e.g. a 7/9 due date rendered under the 7/8 cell.
		// Normalize weekStart to midnight first so the difference is an exact day count.
		const weekStartMidnight = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
		return Math.round((parseISO(iso).getTime() - weekStartMidnight.getTime()) / 86_400_000);
	}

	private isVisible(item: ScheduleItem, category: Category | null): boolean {
		if (item.calendar_visible !== null) return item.calendar_visible;
		return this.isCategoryVisible(category);
	}

	private isCategoryVisible(category: Category | null): boolean {
		return category ? category.calendar_visible : true;
	}

	private renderChip(container: HTMLElement, entry: ChipEntry): void {
		if (entry.kind === "schedule") {
			const { item, category } = entry;
			const chip = container.createDiv({ cls: "lilac-chip lilac-chip-event" });
			if (category) chip.style.setProperty("--lilac-chip-color", category.color);
			const text = item.schedule_kind === "time" && item.time_start ? `${item.time_start} ${item.title}` : item.title;
			chip.createSpan({ cls: "lilac-chip-label", text });
			chip.onclick = (e) => {
				e.stopPropagation();
				void this.openItemTarget(item);
			};
			return;
		}

		const { item } = entry;
		const chip = container.createDiv({ cls: "lilac-chip lilac-chip-todo" });
		const marker = item.do_date ? "▸" : "⏰"; // do_date = 실행 예정일, due-only = 마감 임박 표시
		chip.createSpan({ cls: "lilac-chip-marker", text: marker });
		chip.createSpan({ cls: "lilac-chip-label", text: item.title });
		chip.onclick = (e) => {
			e.stopPropagation();
			void this.openItemTarget(item);
		};
	}

	private async openItemTarget(item: ScheduleItem | TodoItem): Promise<void> {
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
