import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type LilacPlugin from "../main";
import { addDays, parseISO, startOfWeek, toISO, todayISO } from "./dates";
import { buildOccurrences } from "./occurrences";
import { loadHolidays } from "./holidays";
import { openDailyNote } from "./daily-note";
import { LilacItemModal } from "./item-modal";
import { LilacStickyModal } from "./sticky-modal";
import { LilacRoutineListModal } from "./routine-list-modal";
import { formatDailyDateLabel, renderDailySections } from "./daily-render";
import { isCategoryVisible, isScheduleVisible, summarizeTodosByDate } from "./visibility";

export const VIEW_TYPE_SIDEBAR = "lilac-sidebar";

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
/** 미니 달력 칸 하나에 찍는 일정 점 최대 개수(그 이상은 생략) — 좁은 칸이라 3개가 한계. */
const MAX_DOTS_PER_DAY = 3;

/**
 * 오른쪽 사이드바(백링크·개요와 같은 자리)에 붙는 lilac 패널 — 50라운드(2026-10-07)
 * 사용자 요청: "PC랑 태블릿에서 옵시디언 사이드바에 lilac을 쓸 수 있게". 설계는
 * 볼트 `lilac 사이드바 설계` 참고.
 *
 * ① 날짜 줄(‹ 날짜 › + 오늘) ② 도구 줄 ③ 미니 달력(접기 가능) ④ 그 날의 목록.
 * ④는 데일리노트 블록과 **같은 함수**(renderDailySections)라 체크·편집·당겨오기가
 * 어디서 하든 똑같이 동작한다. 미니 달력은 "보기 전환"만 하고 노트를 열지 않는다 —
 * 사이드바를 만지다 실수로 본문 노트가 바뀌지 않게. 노트는 날짜 글자를 눌러야 열린다.
 */
export class LilacSidebarView extends ItemView {
	/** 아래 목록이 보여주는 날짜. */
	private selectedISO: string;
	/** 미니 달력이 보여주는 달(선택 날짜와 따로 움직일 수 있게 — 달만 넘겨 보기). */
	private calYear: number;
	private calMonth: number; // 0-indexed

	constructor(leaf: WorkspaceLeaf, private plugin: LilacPlugin) {
		super(leaf);
		this.selectedISO = todayISO();
		const d = parseISO(this.selectedISO);
		this.calYear = d.getFullYear();
		this.calMonth = d.getMonth();
	}

	getViewType(): string {
		return VIEW_TYPE_SIDEBAR;
	}

	getDisplayText(): string {
		return "Lilac";
	}

	getIcon(): string {
		return "calendar-days";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	/** 인덱스가 바뀌었을 때(체크·편집·동기화) — 보고 있던 날짜·달 그대로 다시 그린다. */
	refresh(): void {
		this.render();
	}

	/**
	 * 따라가기: 데일리노트가 열리면 main.ts가 호출한다. 그 날짜를 선택하고 미니 달력도
	 * 그 달로 옮긴다. 이미 그 날짜면 아무것도 안 한다(불필요한 깜박임 방지).
	 */
	followDate(dateISO: string): void {
		if (!this.plugin.settings.sidebarFollowDailyNote || dateISO === this.selectedISO) return;
		this.select(dateISO);
	}

	private select(dateISO: string): void {
		this.selectedISO = dateISO;
		const d = parseISO(dateISO);
		this.calYear = d.getFullYear();
		this.calMonth = d.getMonth();
		this.render();
	}

	private shiftMonth(n: number): void {
		let m = this.calMonth + n;
		let y = this.calYear;
		while (m < 0) { m += 12; y--; }
		while (m > 11) { m -= 12; y++; }
		this.calMonth = m;
		this.calYear = y;
		this.render();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("lilac-sidebar");

		this.renderDateRow(root);
		this.renderToolRow(root);
		this.renderMiniCalendar(root);

		const list = root.createDiv({ cls: "lilac-daily-block lilac-sidebar-list" });
		const emptyText = this.selectedISO === todayISO() ? "오늘은 일정도 할일도 없습니다." : "이 날은 일정도 할일도 없습니다.";
		renderDailySections(this.app, this.plugin, this.selectedISO, list, () => this.render(), emptyText);
	}

	/** ① ‹ 날짜 › [오늘] — 날짜 글자를 누르면 그 날 데일리노트가 본문에 열린다. */
	private renderDateRow(root: HTMLElement): void {
		const row = root.createDiv({ cls: "lilac-sidebar-daterow" });
		const prev = row.createEl("button", { cls: "lilac-nav-btn", text: "‹" });
		prev.setAttr("aria-label", "전날");
		prev.onclick = () => this.select(toISO(addDays(parseISO(this.selectedISO), -1)));

		const label = row.createEl("button", { cls: "lilac-sidebar-date-label", text: formatDailyDateLabel(this.selectedISO) });
		label.setAttr("aria-label", "이 날의 데일리노트 열기");
		label.onclick = () => void openDailyNote(this.app, parseISO(this.selectedISO));

		const next = row.createEl("button", { cls: "lilac-nav-btn", text: "›" });
		next.setAttr("aria-label", "다음날");
		next.onclick = () => this.select(toISO(addDays(parseISO(this.selectedISO), 1)));

		// 캘린더뷰 헤더의 "오늘" 버튼과 같은 모양(오늘 날짜 숫자를 둥근 박스에).
		const today = row.createEl("button", { cls: "lilac-nav-btn lilac-today-btn", text: String(new Date().getDate()) });
		today.setAttr("aria-label", "오늘로");
		today.onclick = () => this.select(todayISO());
	}

	/** ② 따라가기 · 캘린더 · 추가 · 스티키 · 루틴. */
	private renderToolRow(root: HTMLElement): void {
		const row = root.createDiv({ cls: "lilac-sidebar-toolrow" });

		const follow = this.plugin.settings.sidebarFollowDailyNote;
		const followBtn = this.iconButton(row, follow ? "link" : "unlink", follow ? "따라가기 켜짐 — 데일리노트를 열면 그 날짜로" : "따라가기 꺼짐");
		followBtn.toggleClass("is-active", follow);
		followBtn.onclick = async () => {
			this.plugin.settings.sidebarFollowDailyNote = !follow;
			await this.plugin.saveSettings();
			this.render();
		};

		this.iconButton(row, "calendar-days", "캘린더 열기").onclick = () => void this.plugin.openCalendarView();
		this.iconButton(row, "plus", "이 날에 일정·할일 추가").onclick = () =>
			new LilacItemModal(this.app, this.plugin, { defaultDate: this.selectedISO, onSaved: () => this.render() }).open();
		this.iconButton(row, "sticky-note", "스티키노트").onclick = () => new LilacStickyModal(this.app, this.plugin).open();
		this.iconButton(row, "repeat", "루틴 목록").onclick = () => new LilacRoutineListModal(this.app, this.plugin).open();
	}

	private iconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
		const btn = parent.createEl("button", { cls: "lilac-nav-btn lilac-sidebar-icon-btn" });
		setIcon(btn, icon);
		btn.setAttr("aria-label", label);
		return btn;
	}

	/**
	 * ③ 미니 달력 — 캘린더뷰와 같은 노출 규칙(calendar_visible)으로, 날짜마다 일정
	 * 카테고리 색 점(최대 3개)과 미완료 할일 링만. 제목은 칸이 좁아 넣지 않는다(큰
	 * 캘린더가 따로 있음). 날짜를 누르면 아래 목록만 바뀐다.
	 */
	private renderMiniCalendar(root: HTMLElement): void {
		const wrap = root.createDiv({ cls: "lilac-sidebar-cal" });
		const collapsed = this.plugin.settings.sidebarMiniCalendarCollapsed;

		const head = wrap.createDiv({ cls: "lilac-sidebar-cal-head" });
		const title = head.createEl("button", { cls: "lilac-sidebar-cal-title" });
		title.createSpan({ text: `${String(this.calYear % 100).padStart(2, "0")}년 ${this.calMonth + 1}월` });
		setIcon(title.createSpan({ cls: "lilac-sidebar-cal-chevron" }), collapsed ? "chevron-right" : "chevron-down");
		title.setAttr("aria-label", collapsed ? "달력 펼치기" : "달력 접기");
		title.onclick = async () => {
			this.plugin.settings.sidebarMiniCalendarCollapsed = !collapsed;
			await this.plugin.saveSettings();
			this.render();
		};
		if (collapsed) return;

		const nav = head.createDiv({ cls: "lilac-sidebar-cal-nav" });
		nav.createEl("button", { cls: "lilac-nav-btn", text: "‹" }).onclick = () => this.shiftMonth(-1);
		nav.createEl("button", { cls: "lilac-nav-btn", text: "›" }).onclick = () => this.shiftMonth(1);

		const first = new Date(this.calYear, this.calMonth, 1);
		const gridStart = startOfWeek(first);
		const lastDay = new Date(this.calYear, this.calMonth + 1, 0);
		const gridEnd = addDays(startOfWeek(lastDay), 6);
		const startISO = toISO(gridStart);
		const endISO = toISO(gridEnd);

		const db = this.plugin.getDatabase();
		const categoryById = new Map((db?.getCategories() ?? []).map((c) => [c.id, c]));
		const occurrences = buildOccurrences(
			db?.getScheduleItemsOverlapping(startISO, endISO) ?? [],
			categoryById,
			startISO,
			endISO,
			(item, category) => isScheduleVisible(item, category)
		);
		const todos = (db?.getTodoItemsInRange(startISO, endISO) ?? []).filter((t) =>
			isCategoryVisible(t.category ? categoryById.get(t.category) ?? null : null)
		);
		const todoByDate = summarizeTodosByDate(todos, categoryById, 0);
		const holidayByDate = new Map(loadHolidays(this.app).map((h) => [h.date, h.name]));

		// 날짜별 일정 점 색(겹치는 카테고리 색은 하나로, 미분류는 테마 기본색).
		const dotsByDate = new Map<string, string[]>();
		for (const occ of occurrences) {
			const color = occ.category?.color ?? "var(--text-faint)";
			for (let d = parseISO(occ.startISO); toISO(d) <= occ.endISO; d = addDays(d, 1)) {
				const iso = toISO(d);
				if (iso < startISO || iso > endISO) continue;
				const dots = dotsByDate.get(iso) ?? [];
				if (!dots.includes(color) && dots.length < MAX_DOTS_PER_DAY) dots.push(color);
				dotsByDate.set(iso, dots);
			}
		}

		const grid = wrap.createDiv({ cls: "lilac-sidebar-cal-grid" });
		WEEKDAY_LABELS.forEach((w, i) => {
			const cell = grid.createDiv({ cls: "lilac-sidebar-cal-weekday", text: w });
			if (i === 0) cell.addClass("is-sunday");
			if (i === 6) cell.addClass("is-saturday");
		});

		const today = todayISO();
		for (let d = gridStart; toISO(d) <= endISO; d = addDays(d, 1)) {
			const iso = toISO(d);
			const cell = grid.createEl("button", { cls: "lilac-sidebar-cal-day" });
			if (d.getMonth() !== this.calMonth) cell.addClass("is-other-month");
			if (d.getDay() === 0 || holidayByDate.has(iso)) cell.addClass("is-sunday");
			else if (d.getDay() === 6) cell.addClass("is-saturday");
			if (iso === today) cell.addClass("is-today");
			if (iso === this.selectedISO) cell.addClass("is-selected");

			cell.createDiv({ cls: "lilac-sidebar-cal-num", text: String(d.getDate()) });
			const marks = cell.createDiv({ cls: "lilac-sidebar-cal-marks" });
			for (const color of dotsByDate.get(iso) ?? []) {
				marks.createDiv({ cls: "lilac-sidebar-cal-dot" }).style.background = color;
			}
			const todo = todoByDate.get(iso);
			if (todo && todo.pending > 0) marks.createDiv({ cls: "lilac-sidebar-cal-todo" });

			const holiday = holidayByDate.get(iso);
			cell.setAttr("aria-label", holiday ? `${iso} ${holiday}` : iso);
			cell.onclick = () => this.select(iso);
		}
	}
}
