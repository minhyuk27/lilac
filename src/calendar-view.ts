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
	isStart: boolean; // true if this segment contains the occurrence's actual first day
	isEnd: boolean; // true if this segment contains the occurrence's actual last day
}

const MAX_CHIPS_PER_DAY = 3;

/** How many of a day's todos are still pending vs. already finished — drives the day badge. */
interface TodoDaySummary {
	pending: number;
	done: number;
}

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
		const todoSummaryByDate = this.summarizeTodosByDate(todos);

		this.renderHeader(container, gridStart, gridEnd);
		this.renderGrid(container, gridStart, occurrences, todoSummaryByDate);
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

	private renderGrid(
		container: HTMLElement,
		gridStart: Date,
		occurrences: Occurrence[],
		todoSummaryByDate: Map<string, TodoDaySummary>
	): void {
		const grid = container.createDiv({ cls: "lilac-calendar-grid" });

		const weekdayRow = grid.createDiv({ cls: "lilac-calendar-weekdays" });
		WEEKDAY_LABELS.forEach((label, i) => {
			const cell = weekdayRow.createDiv({ cls: "lilac-calendar-weekday", text: label });
			if (i === 0) cell.addClass("lilac-sunday");
			if (i === 6) cell.addClass("lilac-saturday");
		});

		const today = new Date();

		// First pass: place bands for every week, and find the largest lane count across
		// ALL of them — see lilac DECISIONS 2026-06-07 ("일정있는 열이 달력칸을 나누는
		// 표를 벌려서 한 줄이 더 생기는 식"): computing the row template per-week meant
		// weeks with period events reserved extra lane rows while weeks without them
		// didn't, so week rows ended up different heights and the grid's horizontal
		// dividing lines looked uneven/pushed apart. Reserving the same fixed band-lane
		// space in every row — even when a given week has nothing to show there — keeps
		// every week row the same height, exactly like Google/Samsung Calendar.
		const weeks = Array.from({ length: GRID_WEEKS }, (_, week) => {
			const weekStart = addDays(gridStart, week * 7);
			const weekStartISO = toISO(weekStart);
			const weekEndISO = toISO(addDays(weekStart, 6));
			return { weekStart, bands: this.placeBands(occurrences, weekStart, weekStartISO, weekEndISO) };
		});
		const laneCount = Math.max(0, ...weeks.map((w) => Math.max(0, ...w.bands.map((b) => b.lane + 1))));
		// CSS custom properties can't drive repeat()'s count, so build the track list directly:
		// one fixed-height row per band lane, then a flexible row for the day cells. The band's
		// own height (.lilac-band) and this track height both scale off the same inherited
		// font-size at a fixed ratio, so a band can never be taller than its lane and get
		// clipped by the row's overflow:hidden.
		const rowTemplate = `${"1.9em ".repeat(laneCount)}minmax(5em, 1fr)`;

		weeks.forEach(({ weekStart, bands }, week) => {
			const weekEl = grid.createDiv({ cls: "lilac-calendar-week" });
			if (week === REFERENCE_ROW) weekEl.addClass("lilac-reference-week");
			weekEl.style.gridTemplateRows = rowTemplate;

			for (const band of bands) {
				const el = weekEl.createDiv({ cls: "lilac-band" });
				if (!band.isStart) el.addClass("lilac-band-continues-left");
				if (!band.isEnd) el.addClass("lilac-band-continues-right");
				el.style.gridColumn = `${band.startCol + 1} / ${band.endCol + 2}`;
				el.style.gridRow = `${band.lane + 1}`;
				if (band.category) el.style.setProperty("--lilac-chip-color", band.category.color);
				el.setText(band.item.title);
				el.onclick = (e) => {
					e.stopPropagation();
					void this.openItemTarget(band.item);
				};
			}

			const chipsByCol = this.collectDayChips(occurrences, weekStart);

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

				// Todomate-style day badge (사용자가 직접 캡처해 보여준 참고 화면): one summary
				// indicator per day rather than per-item — ✓ once everything due that day is
				// done, otherwise the remaining count. This is what actually solved "아이콘만
				// 보이고 내용이 안 보여" for todos: there's no title text to truncate anymore.
				const summary = todoSummaryByDate.get(dateISO);
				if (summary && (summary.pending > 0 || summary.done > 0)) {
					const badge = dateLabel.createSpan({ cls: "lilac-todo-badge" });
					if (summary.pending > 0) {
						badge.setText(String(summary.pending));
					} else {
						badge.addClass("lilac-todo-badge-done");
						badge.setText("✓");
					}
				}

				// 일정(이벤트)은 이름이 있는 항목이라 — 사용자 요청대로 — 점이 아니라
				// 카테고리 색이 입혀진 텍스트 칩으로 표시 (Google Calendar 월간뷰와 동일한 언어).
				const entries = chipsByCol.get(day) ?? [];
				const visible = entries.slice(0, MAX_CHIPS_PER_DAY);
				for (const entry of visible) this.renderEventChip(cell, entry);
				if (entries.length > visible.length) {
					cell.createDiv({ cls: "lilac-cell-more", text: `+${entries.length - visible.length}개` });
				}
			}
		});
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

		// Done todos are now included (see getTodoItemsInRange — needed so the badge's "✓ 다 끝냄"
		// state has something to show when tapped). Sort them to the bottom with a muted/struck
		// style so the agenda still reads "what's left" first, "what's done" second.
		for (const todo of dayTodos) {
			rows.push({
				sortKey: `${todo.done ? 2 : 1}_${todo.title}`,
				render: (parent) => {
					const row = parent.createDiv({ cls: "lilac-detail-row lilac-detail-row-todo" });
					if (todo.done) row.addClass("lilac-detail-row-done");
					const marker = todo.done ? "✓" : todo.do_date === dateISO ? "▸" : "⏰";
					row.createDiv({ cls: "lilac-detail-marker", text: marker });
					const text = row.createDiv({ cls: "lilac-detail-text" });
					const timeLabel = todo.done ? "완료" : todo.do_date === dateISO ? "실행 예정" : "마감";
					text.createSpan({ cls: "lilac-detail-time", text: timeLabel });
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
				const rawStart = this.dayOffset(weekStart, o.startISO);
				const rawEnd = this.dayOffset(weekStart, o.endISO);
				// A multi-week occurrence is necessarily split into one segment per row —
				// that's unavoidable in any grid layout (Google/Samsung Calendar do the same).
				// What reads as "broken" is when every segment looks like its own pill with
				// rounded ends; isStart/isEnd let the renderer square off the edges that are
				// mid-occurrence cuts, so consecutive rows visually read as one continuing bar.
				return {
					...o,
					startCol: Math.max(0, rawStart),
					endCol: Math.min(6, rawEnd),
					isStart: rawStart >= 0,
					isEnd: rawEnd <= 6,
					lane: 0,
				};
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

	/**
	 * Single-day schedule occurrences for this week, grouped by weekday column (0=Sun..6=Sat).
	 * Todos are intentionally absent here — they're summarized into the day badge instead
	 * (see lilac DECISIONS 2026-06-07, Todomate 참고: "todo와 일정을 확실히 구분해").
	 */
	private collectDayChips(occurrences: Occurrence[], weekStart: Date): Map<number, Occurrence[]> {
		const map = new Map<number, Occurrence[]>();
		for (const occ of occurrences) {
			if (occ.startISO !== occ.endISO) continue; // bands handled separately
			const col = this.dayOffset(weekStart, occ.startISO);
			if (col < 0 || col > 6) continue;
			const list = map.get(col);
			if (list) list.push(occ);
			else map.set(col, [occ]);
		}
		for (const list of map.values()) {
			list.sort((a, b) => (a.item.time_start ?? "").localeCompare(b.item.time_start ?? "") || a.item.title.localeCompare(b.item.title));
		}
		return map;
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

	/** A single-day event shown by name — same visual language as a band, just not grid-spanned. */
	private renderEventChip(container: HTMLElement, occ: Occurrence): void {
		const chip = container.createDiv({ cls: "lilac-event-chip" });
		if (occ.category) chip.style.setProperty("--lilac-chip-color", occ.category.color);
		const text = occ.item.schedule_kind === "time" && occ.item.time_start ? `${occ.item.time_start} ${occ.item.title}` : occ.item.title;
		chip.setText(text);
		chip.onclick = (e) => {
			e.stopPropagation();
			void this.openItemTarget(occ.item);
		};
	}

	/** Buckets each todo's date (do_date if set, else due) into pending/done counts for the day badge. */
	private summarizeTodosByDate(todos: TodoItem[]): Map<string, TodoDaySummary> {
		const map = new Map<string, TodoDaySummary>();
		for (const todo of todos) {
			const dateISO = todo.do_date ?? todo.due;
			if (!dateISO) continue;
			const summary = map.get(dateISO) ?? { pending: 0, done: 0 };
			if (todo.done) summary.done++;
			else summary.pending++;
			map.set(dateISO, summary);
		}
		return map;
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
