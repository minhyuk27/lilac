import { ItemView, WorkspaceLeaf, TFile, setIcon, Platform } from "obsidian";
import type LilacPlugin from "../main";
import { Category, ScheduleItem, TodoItem } from "./types";
import { addDays, isSameDay, startOfWeek, toISO, parseISO } from "./dates";
import { Occurrence, buildOccurrences } from "./occurrences";
import { darken, lighten, cellTint, chipTextColor, CHIP_BG_LIGHTEN, CHIP_TEXT_DARKEN } from "./color";
import { openDailyNote } from "./daily-note";
import { LilacStickyModal } from "./sticky-modal";
import { LilacRoutineListModal } from "./routine-list-modal";
import { loadHolidays } from "./holidays";
import { isScheduleVisible, isCategoryVisible, summarizeTodosByDate, TodoDaySummary } from "./visibility";

export const VIEW_TYPE_CALENDAR = "lilac-calendar";

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

interface BandPlacement extends Occurrence {
	startCol: number; // 0-6, column within its week
	endCol: number; // 0-6 inclusive
	lane: number;
	isStart: boolean; // true if this segment contains the occurrence's actual first day
	isEnd: boolean; // true if this segment contains the occurrence's actual last day
}

/**
 * 레이아웃 밀도 3단계 — "auto"면 캘린더 패널의 실제 폭으로 판단, 설정 탭에서 강제
 * 선택하면 폭과 무관하게 그 값을 그대로 씀(사용자 요청, 2026-08-15: "태블릿이나
 * 상황에 따라 내가 직접 설정 가능하게"). 옵시디언 앱 자체가 모바일 클라이언트인지
 * (Platform.isMobile, 아래 몰입형 헤더 처리)와는 별개의 축이다.
 */
type DeviceMode = "mobile" | "tablet" | "desktop";

/** `resolveDeviceMode()`가 "auto"일 때 쓰는 캘린더 패널 폭(px) 기준 — 이 값들이 바뀌면
 * 아래 두 threshold와 styles.css의 대응 규칙(`[data-device="tablet"/"desktop"]`)도
 * 개념적으로는 무관(폭→모드 매핑은 여기서만, 스타일은 모드 문자열만 소비)하므로 안전. */
const TABLET_MIN_WIDTH = 600;
const DESKTOP_MIN_WIDTH = 900;

// 모바일 칸이 고정 높이(styles.css `.lilac-calendar-week { grid-template-rows: 8rem }`)
// 라서 실제로 그 안에 들어가는 개수로 줄임 — 전엔 3개였지만 고정 높이 안에서 밴드까지
// 합치면 3개는 넘치는 날이 많았음(2026-06-21, "캘린더 크기 고정" 요청과 함께 조정).
// 태블릿은 그 중간값(신규, 2026-08-15) — 실기기 피드백 전 첫 추정치.
const MAX_CHIPS_PER_DAY: Record<DeviceMode, number> = {
	mobile: 2,
	tablet: 4,
	desktop: 6,
};

// 단위가 전부 `rem`인 이유: `.lilac-band`/`.lilac-event-chip`처럼 자기 자신에게
// `font-size`를 따로 지정한 요소에서 `em` 단위의 `height`/`margin`을 쓰면, 그 값은
// "캘린더 전체의 기준 글꼴 크기"가 아니라 **그 요소 자신의(축소된) font-size**를
// 기준으로 다시 계산된다 — 예: `.lilac-band`는 `font-size:0.68em`이므로
// `height:1.6em`은 실제로 `1.6 × 0.68 = 1.088`배만큼만 커짐. 반면 `.lilac-cell-date`/
// `.lilac-calendar-cell`처럼 font-size를 직접 안 건드리는 요소의 `em`은 그대로
// 캘린더 기준 크기를 따름 — 그래서 같은 "1.6em"이라도 요소마다 실제 픽셀이 달랐고,
// 이게 4번의 라운드(2026-06-21)에 걸쳐 "밴드/칩 사이 공백·정렬"이 추측으로는 절대
// 안 맞던 진짜 원인이었음. `rem`은 항상 문서 루트 글꼴 크기 기준이라 요소 자신의
// font-size와 무관하게 고정값 — 이 정렬 시스템에 참여하는 모든 요소가 `rem`을 쓰면
// 더는 이 문제가 발생할 수 없다(자기 자신의 font-size를 텍스트 크기로만 쓰고,
// 레이아웃 치수는 전부 rem으로 분리).
/**
 * Height of one band lane, in rem (matches the per-lane offset math in renderGrid/styles.css).
 * 1.6 → 1.15: 삼성캘린더 샘플은 밴드/칩이 텍스트 줄 높이에 거의 딱 맞는 얇은 띠인데,
 * 1.6rem은 0.64em 텍스트보다 훨씬 두꺼워 글자가 그 안에서 작고 흐릿하게 떠 보였음
 * (사용자 보고, 2026-06-22: "두께 더 줄여서 삼성캘린더처럼... 글자가 거의 안 보여").
 * 글자 크기는 그대로 두고 박스만 얇혀서 같은 글자가 상대적으로 더 꽉 차 보이게 함.
 */
const LANE_HEIGHT_REM = 1.15;

/**
 * Vertical space the date number row occupies at the top of every cell (cell's own
 * top padding + the date circle's height + the gap before whatever comes next) —
 * bands anchor below this offset so the date number always renders first, with the
 * band(s) directly under it and per-day chips under those (matches the Samsung
 * Calendar sample: date row -> all-day band -> per-day entries, top to bottom).
 * Must be kept in sync with `.lilac-calendar-cell`'s padding-top/gap and
 * `.lilac-cell-date`'s height in styles.css (all in `rem`, see note above).
 */
const DATE_ROW_OFFSET_REM = 2.1;

const MAX_BADGE_COLORS = 4;

// CHIP_BG_LIGHTEN/CHIP_TEXT_DARKEN moved to color.ts (2026-08-15) — item-modal.ts's
// category picker now shares the exact same mix ratios so a category reads as the same
// color in the calendar grid and the add/edit modal. History: 0.82 lightened the
// background almost to white, especially for categories whose own color was already a
// soft tone — chips became nearly invisible (사용자 보고, 2026-06-22, test5.jpg: "여전히
// 못생겼어"). 0.5/0.35 keeps the hue clearly visible while still reading as "pastel".

/**
 * How far a category color is mixed toward white for the *cell tile's own* background
 * (separate from `CHIP_BG_LIGHTEN`, which tints the chip/band sitting inside the cell) —
 * Claude Design 목업 사양(2026-06-22): 칸 배경은 칩보다 한 단계 더 연하게.
 */
const CELL_TINT_LIGHTEN = 0.88;

/**
 * 캘린더뷰: 일정 밴드/칩 + todo 잔여개수 배지는 그대로 그리드에 표시한다(사용자가
 * 명시적으로 "기존의 스케줄과 todo아이콘만 있다는 뜻"이라고 정정, 2026-06-21).
 * 없앤 건 그리드 *아래* "선택한 날의 일정들" day-detail 패널뿐 — 그리드 셀이 좁아
 * 전체 텍스트를 못 보여주는 문제는 day-detail 패널이 아니라 데일리노트
 * (`lilac-daily` 코드블록)가 대신 맡는다. 날짜를 누르면 바로 그 날의 데일리노트로
 * 이동한다.
 */
export class LilacCalendarView extends ItemView {
	private currentYear: number;
	private currentMonth: number; // 0-indexed (0 = January)

	constructor(leaf: WorkspaceLeaf, private plugin: LilacPlugin) {
		super(leaf);
		const today = new Date();
		this.currentYear = today.getFullYear();
		this.currentMonth = today.getMonth();
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
		// 옵시디언 기본 view-header(사이드바 토글/탭 제목/… 메뉴)가 lilac 자체 헤더
		// (제목+▲▼오늘+📌) 위에 그대로 얹혀 "이중 헤더"처럼 보이던 것 — 실제 옵시디언
		// 모바일 클라이언트(폰/태블릿)에서만 완전히 숨기고 lilac 헤더가 유일한 헤더
		// 역할을 하게 한다(사용자 요청, 2026-08-15: "옵시디언 내부에서 완전히
		// 외부앱인거처럼"). `Platform.isMobile`은 실제 앱 종류를 보는 것이라 데스크톱
		// 앱 창을 아무리 좁혀도 켜지지 않음 — 아래 레이아웃 밀도(태블릿/PC 강제
		// 설정)와는 완전히 별개의 축. CSS는 styles.css의 `.lilac-immersive` 참고.
		if (Platform.isMobile) this.containerEl.addClass("lilac-immersive");
		this.render();
	}

	/**
	 * Re-render in place — called by the plugin after the index changes underneath us.
	 * Used to skip rendering when `!contentEl.isShown()` (e.g. this calendar sitting in
	 * a background tab) as a micro-optimization — but a leaf that's hidden *right now*
	 * can still become the active tab later with no further "something changed" event
	 * to re-trigger a render, so it just sat stale until the user ran "Rebuild index"
	 * while actually looking at it (사용자 보고, 2026-06-21: "calendar에서도 rebuild
	 * index 해야 표시되는 증상"). Always rendering is cheap (small DOM) — correctness
	 * over a no-op optimization that wasn't worth the staleness it caused.
	 */
	refresh(): void {
		this.render();
	}

	private gridStart(): Date {
		return startOfWeek(new Date(this.currentYear, this.currentMonth, 1));
	}

	/** 이 달의 표시에 필요한 주 수 (4~6). 1일이 속한 주의 일요일부터 말일이 속한 주의 토요일까지. */
	private gridWeekCount(): number {
		const start = this.gridStart();
		const lastDay = new Date(this.currentYear, this.currentMonth + 1, 0);
		const end = addDays(startOfWeek(lastDay), 6);
		return Math.round((end.getTime() - start.getTime()) / 86_400_000 + 1) / 7;
	}

	private shiftMonths(n: number): void {
		let m = this.currentMonth + n;
		let y = this.currentYear;
		while (m < 0) { m += 12; y--; }
		while (m > 11) { m -= 12; y++; }
		this.currentMonth = m;
		this.currentYear = y;
		this.render();
	}

	private goToToday(): void {
		const today = new Date();
		this.currentYear = today.getFullYear();
		this.currentMonth = today.getMonth();
		this.render();
	}

	/**
	 * "auto"면 캘린더 패널의 실제 폭(`clientWidth`)으로 판단 — `window.innerWidth`(뷰포트)
	 * 대신 패널 자기 자신의 너비를 봐야 창을 분할해도 정확하다(2026-06-21 결정 그대로
	 * 계승). 설정 탭에서 mobile/tablet/desktop을 직접 골랐으면 폭과 무관하게 그 값을
	 * 그대로 쓴다 — 사용자 요청, 2026-08-15.
	 */
	private resolveDeviceMode(): DeviceMode {
		const forced = this.plugin.settings.deviceMode;
		if (forced !== "auto") return forced;
		const width = this.contentEl.clientWidth;
		if (width >= DESKTOP_MIN_WIDTH) return "desktop";
		if (width >= TABLET_MIN_WIDTH) return "tablet";
		return "mobile";
	}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("lilac-calendar");
		const deviceMode = this.resolveDeviceMode();
		// styles.css가 `@container` 쿼리 대신 이 값으로 밀도를 정한다 — 수동 강제 설정은
		// 패널 폭과 무관해야 하므로 순수 CSS 쿼리로는 표현할 수 없어 JS에서 계산해
		// 데이터 속성으로 내려준다(2026-08-15).
		container.dataset.device = deviceMode;
		// PC 글자 크기는 자동 브레이크포인트가 아니라 설정 탭의 수동 슬라이더로 —
		// styles.css의 `[data-device="desktop"]` 블록 안에서만 쓰여 모바일/태블릿
		// 밀도에는 영향이 없다(사용자 요청, 2026-06-22).
		container.style.setProperty("--lilac-pc-font-scale", String(this.plugin.settings.calendarPcFontScale / 100));

		const numWeeks = this.gridWeekCount();
		const gridStart = this.gridStart();
		const gridEnd = addDays(gridStart, numWeeks * 7 - 1);
		const gridStartISO = toISO(gridStart);
		const gridEndISO = toISO(gridEnd);

		const db = this.plugin.getDatabase();
		const categoryById = new Map((db?.getCategories() ?? []).map((c) => [c.id, c]));
		const occurrences = buildOccurrences(
			db?.getScheduleItemsOverlapping(gridStartISO, gridEndISO) ?? [],
			categoryById,
			gridStartISO,
			gridEndISO,
			(item, category) => isScheduleVisible(item, category)
		);
		const todos = (db?.getTodoItemsInRange(gridStartISO, gridEndISO) ?? []).filter((t) =>
			isCategoryVisible(t.category ? categoryById.get(t.category) ?? null : null)
		);
		const todoSummaryByDate = summarizeTodosByDate(todos, categoryById, MAX_BADGE_COLORS);
		// 공휴일(고정 공휴일은 자동 계산, 설날/추석 등 음력 공휴일과 대체공휴일은 설정
		// 탭에서 사용자가 추가 — holidays.ts 참고). 날짜 자체가 몇 개 안 되는 조회라
		// DB에 안 두고 매 렌더마다 그냥 다시 계산/조회한다.
		const holidayByDate = new Map(loadHolidays(this.app).map((h) => [h.date, h.name]));

		this.renderHeader(container);
		this.renderGrid(container, gridStart, numWeeks, occurrences, todoSummaryByDate, holidayByDate, deviceMode);
	}

	/**
	 * 한 줄: 큰 제목(flex:1로 남는 공간을 다 차지) + 버튼들 — Claude Design 목업
	 * 기준(2026-06-22). 제목이 `flex:1`이라 버튼들은 항상 줄 오른쪽에 자연히 붙고,
	 * 좁은 화면에서 줄바꿈돼도 `margin-left:auto` 같은 트릭이 없어 버튼이 외따로
	 * 떠서 빈 공백을 만들던 이전 회귀(test5.jpg)가 구조적으로 재발하지 않는다.
	 * 버튼은 정확히 ▲/오늘/▼/📌 네 개 — "오늘"은 기준 주를 오늘이 포함된 주로
	 * 되돌리는 네비게이션 기능만 하고, 노트를 열지는 않는다(사용자 사양,
	 * 2026-06-22: "today버튼은... 기본상태로 돌리는 기능만"). 날짜 칸을 누르면
	 * 그 날의 데일리노트가 열리는 기존 동작으로 충분하다고 판단해 별도 "오늘 노트"
	 * 버튼은 뺐다. "오늘" 버튼은 삼성캘린더처럼 텍스트 대신 오늘 날짜(일) 숫자를
	 * 둥근 사각 박스에 담아 보여준다(사용자 요청, 2026-06-22).
	 */
	private renderHeader(container: HTMLElement): void {
		const header = container.createDiv({ cls: "lilac-calendar-header" });

		header.createDiv({ cls: "lilac-calendar-label", text: this.formatMonthLabel() });

		const nav = header.createDiv({ cls: "lilac-calendar-nav" });
		nav.createEl("button", { cls: "lilac-nav-btn", text: "▲" }).onclick = () => this.shiftMonths(-1);
		nav.createEl("button", { cls: "lilac-nav-btn lilac-today-btn", text: String(new Date().getDate()) }).onclick =
			() => this.goToToday();
		nav.createEl("button", { cls: "lilac-nav-btn", text: "▼" }).onclick = () => this.shiftMonths(1);
		// todo/schedule과 무관한 자유 메모 — 윈도우 스티키노트처럼 버튼 하나로 항상 열 수 있게.
		// 이모지(📌)보다 Obsidian 기본 lucide 아이콘 쪽이 테마 색/다른 아이콘들과 더
		// 잘 어울려서 교체(사용자 요청, 2026-06-22: "더 이쁜걸로").
		const stickyBtn = nav.createEl("button", { cls: "lilac-nav-btn lilac-sticky-btn" });
		setIcon(stickyBtn, "sticky-note");
		stickyBtn.onclick = () => new LilacStickyModal(this.app, this.plugin).open();

		// 다른 화면들과 같은 자리에 "오늘 노트로 바로가기"(사용자 요청, 2026-08-24).
		const todayNoteBtn = nav.createEl("button", { cls: "lilac-nav-btn" });
		setIcon(todayNoteBtn, "calendar-check");
		todayNoteBtn.onclick = () => void openDailyNote(this.app, new Date());

		// "루틴들만 따로 확인할 수 있는 방법"(사용자 요청, 2026-08-16) — 매주 반복
		// 일정만 모아보는 목록. 스티키노트 버튼과 같은 자리(캘린더 헤더)에 나란히.
		const routineBtn = nav.createEl("button", { cls: "lilac-nav-btn" });
		setIcon(routineBtn, "repeat");
		routineBtn.onclick = () => new LilacRoutineListModal(this.app, this.plugin).open();
	}

	private formatMonthLabel(): string {
		const yy = String(this.currentYear % 100).padStart(2, "0");
		return `${yy}년 ${this.currentMonth + 1}월`;
	}

	private renderGrid(
		container: HTMLElement,
		gridStart: Date,
		numWeeks: number,
		occurrences: Occurrence[],
		todoSummaryByDate: Map<string, TodoDaySummary>,
		holidayByDate: Map<string, string>,
		deviceMode: DeviceMode
	): void {
		const grid = container.createDiv({ cls: "lilac-calendar-grid" });
		const gridEnd = addDays(gridStart, numWeeks * 7 - 1);
		const cellTints = this.buildCellTints(occurrences, toISO(gridStart), toISO(gridEnd));

		// 넓은 밀도(태블릿/PC)에서는 칸도 커지므로(styles.css의 [data-device] 규칙) 같은
		// 자리에 더 많은 일정을 그대로 보여줄 수 있다 — 사용자 요청(2026-06-21):
		// "pc에서는 일정 더 여러개 보이게 캘린더 조금더 크게". 좁은 칸에서는 그만큼만
		// 보이고 나머지는 "+N"으로.
		const maxChipsPerDay = MAX_CHIPS_PER_DAY[deviceMode];
		// PC 밀도에서만 칩/밴드(일정 이름) 글자 크기를 설정 탭 슬라이더로 수동 조절 —
		// 사용자 보고, 2026-06-22: "캘린더 글자라는게 제목이나 이런게 아니라 달력
		// 안에 일정들 이름이 작게 보여" (제목/요일/날짜 숫자는 이 스케일과 무관,
		// styles.css 참고). 박스 높이(LANE_HEIGHT_REM)도 같은 비율로 같이 키워야
		// 글자만 커지고 박스는 그대로라 잘려 보이는 일이 없다 — 그래서 이 스케일을
		// 칩/밴드의 레인 간격 계산에도 그대로 곱해서 쓴다(아래 laneHeightRem). 태블릿은
		// 아직 이 슬라이더 대상이 아님(2026-08-15 신규 밀도, 첫 추정치라 우선 보수적으로).
		const eventScale = deviceMode === "desktop" ? this.plugin.settings.calendarPcFontScale / 100 : 1;
		const laneHeightRem = LANE_HEIGHT_REM * eventScale;

		const weekdayRow = grid.createDiv({ cls: "lilac-calendar-weekdays" });
		WEEKDAY_LABELS.forEach((label, i) => {
			const cell = weekdayRow.createDiv({ cls: "lilac-calendar-weekday", text: label });
			if (i === 0) cell.addClass("lilac-sunday");
			if (i === 6) cell.addClass("lilac-saturday");
		});

		const today = new Date();

		// First pass: place bands for every week, and find the largest lane count across
		// ALL of them so every week's *cell* reserves the same total height (lilac
		// DECISIONS 2026-06-07/08 — giving bands their own per-week row caused uneven
		// week heights and "유령 행" grid bugs). But the chips inside a week with *fewer*
		// lanes than that global max must not be pushed down by the global amount — that
		// left a visible empty gap between this week's (single-lane) band and its own
		// chips, sized for some *other* week's deeper stack (사용자 보고, 2026-06-21:
		// "기간 일정이랑 당일 일정 사이에 공백"). So chips offset by *this week's own*
		// lane count, and the global/this-week difference is pushed to a trailing spacer
		// *after* the chips instead — same total reserved height (so weeks still match),
		// but the gap moves to the bottom of an under-populated cell instead of sitting
		// between the band and the chips that actually belong together.
		const weeks = Array.from({ length: numWeeks }, (_, week) => {
			const weekStart = addDays(gridStart, week * 7);
			const weekStartISO = toISO(weekStart);
			const weekEndISO = toISO(addDays(weekStart, 6));
			return { weekStart, bands: this.placeBands(occurrences, weekStart, weekStartISO, weekEndISO) };
		});
		const laneCount = Math.max(0, ...weeks.map((w) => Math.max(0, ...w.bands.map((b) => b.lane + 1))));

		const todayStr = toISO(today);
		weeks.forEach(({ weekStart, bands }) => {
			const weekEl = grid.createDiv({ cls: "lilac-calendar-week" });
			if (todayStr >= toISO(weekStart) && todayStr <= toISO(addDays(weekStart, 6)))
				weekEl.addClass("lilac-reference-week");

			const chipsByCol = this.collectDayChips(occurrences, weekStart);

			for (let day = 0; day < 7; day++) {
				const date = addDays(weekStart, day);
				const dateISO = toISO(date);
				const cell = weekEl.createDiv({ cls: "lilac-calendar-cell" });
				cell.style.gridColumn = `${day + 1}`;
				// Must be explicit, not auto — see lilac DECISIONS 2026-06-08 ("유령 행"):
				// the grid's auto-placement algorithm positions every definitely-placed item
				// (bands have explicit grid-row+grid-column) before auto-placed ones and
				// treats their area as occupied, so a `grid-row: auto` cell whose column a
				// band spans gets shoved into a brand-new implicit row. Explicit `grid-row: 1`
				// on the cell too makes both definitely-placed, so Grid just lets them overlap.
				cell.style.gridRow = "1";
				if (day === 0) cell.addClass("lilac-sunday");
				if (day === 6) cell.addClass("lilac-saturday");
				if (isSameDay(date, today)) cell.addClass("lilac-today");
				if (date.getMonth() !== this.currentMonth) cell.addClass("lilac-other-month");
				// 칸 안쪽 배경은 이미 일정 카테고리 색이 차지하고 있어(아래 tint), 휴일은
				// 채우기 대신 테두리 링 색으로만 표시한다(사용자 제안, 2026-08-21: "칸안에는
				// 일정에 맞는 분야로 색이 들어가니까 테두리 라인에 색을 넣는거 어때").
				// `.lilac-today`와 동시에 적용되면 styles.css가 두 겹 링(바깥 회색=오늘,
				// 안쪽 빨강=휴일)으로 합쳐 보여준다 — 서로 안 가린다.
				const holidayName = holidayByDate.get(dateISO);
				if (holidayName) {
					cell.addClass("lilac-holiday");
					cell.setAttribute("title", holidayName);
				}
				// 칸 배경 = 그날 걸쳐있는 일정 중 가장 긴 일정의 카테고리 색을 밝은/어두운
				// 테마 기준(흰색/검정 쪽)으로 88% 섞은 값(없으면 CSS 기본 배경 그대로) —
				// Claude Design 목업 사양, 2026-06-22. `cellTint()`가 라이트/다크 테마를
				// 갈라 섞는 방향을 고르고, `chipTextColor()`로 그 결과 배경에 맞는 날짜
				// 숫자 색(`--lilac-cell-text`)까지 같이 정한다 — 다크 테마에서 셀이 거의
				// 흰색으로 물들면서 `--text-normal`(다크 테마에선 밝은색) 날짜 숫자가
				// 안 보이던 문제 수정(사용자 요청, 2026-08-18: "다크모드 만들어줘").
				const tintOcc = cellTints.get(dateISO);
				if (tintOcc?.category) {
					const bg = cellTint(tintOcc.category.color, CELL_TINT_LIGHTEN);
					cell.style.setProperty("--lilac-cell-bg", bg);
					cell.style.setProperty("--lilac-cell-text", chipTextColor(bg));
				}
				// 그리드 아래 별도 상세 패널이 더 이상 없으므로, 셀을 누르면 바로 그 날의
				// 데일리노트로 이동한다(날짜 숫자만 누르나 칸 어디를 누르나 동일하게).
				cell.onclick = () => void openDailyNote(this.app, date);

				const topRow = cell.createDiv({ cls: "lilac-cell-top" });
				const dateLabel = topRow.createDiv({ cls: "lilac-cell-date", text: this.formatDateLabel(date) });
				if (date.getDate() === 1) dateLabel.addClass("lilac-month-start");

				// Todomate-style day badge: one summary indicator per day rather than per-item —
				// ✓ once everything due that day is done, otherwise the remaining count.
				const summary = todoSummaryByDate.get(dateISO);
				if (summary && (summary.pending > 0 || summary.done > 0)) this.renderTodoBadge(topRow, summary);

				// 일정(이벤트)은 이름이 있는 항목이라 점이 아니라 카테고리 색이 입혀진 텍스트
				// 칩으로 표시(Google/Samsung Calendar 월간뷰와 동일한 언어). 별도 래퍼
				// (.lilac-cell-chips)에 담아 *이 날짜 칸을 실제로 지나가는* 밴드 레인
				// 수만큼만 margin-top을 줘서, 칩은 이 칸 위에 실제로 뜬 밴드 바로 아래
				// 붙게 한다. 전역(월 전체) 레인 수를 쓰면 다른 주의 밴드 수에 따라 이 주의
				// 칩이 불필요하게 더 밀려나는 문제(2026-06-22 수정)를 "이 주의" 레인
				// 수(`weekLaneCount`, 그 주 7일 중 가장 많이 겹치는 날 기준)로 한 차례
				// 고쳤었지만, 그 값도 여전히 "이 칸" 기준이 아니라 "이 주 전체에서 가장
				// 붐비는 날" 기준이라 문제가 남아있었다 — 예를 들어 한 주 안에서 어느
				// 한 요일에만 밴드가 2겹(레인 0+1)으로 겹치면, 그 요일과 무관한 다른
				// 요일들의 칩까지 전부 레인 2개분만큼 밀려나 밴드가 실제로는 1겹뿐인
				// 칸에도 밴드-칩 사이에 불필요한 빈 틈이 생겼다(사용자 보고, 2026-08-18,
				// 스크린샷: 8/20 "오디세이"가 8/22 "대구"보다 밴드에서 더 멀리 떨어져
				// 보임 — 8/22엔 "8월 휴가"와 "대구" 밴드가 겹쳐 레인이 2개였고, 8/20은
				// "8월 휴가" 밴드 1개(레인 0)뿐인데도 주 전체 최댓값인 레인 2개 분량을
				// 그대로 적용받아 밀려났던 것). 이제 각 칸이 자기 칼럼을 실제로 지나가는
				// 밴드들 중 최댓값(`dayLaneCount`)만 본다.
				//
				// `+ 0.25`: 밴드의 marginTop 공식(아래)은 `DATE_ROW_OFFSET_REM + lane*LANE_HEIGHT_REM
				// + 0.1`이라 밴드의 실제 아래쪽 끝은 여기 공식이 가정하는 `dayLaneCount *
				// LANE_HEIGHT_REM`보다 0.1rem 더 내려가 있었음 — 칩이 그만큼 밴드 쪽으로
				// 파고들어 같은 색일 때 경계가 안 보이고 한 덩어리로 "합쳐져서 보이는" 버그
				// (사용자 보고, 2026-06-22, test4.jpg: "6월 휴가" 밴드와 "만달로리안" 칩이
				// 맞붙어 보임). 그 0.1rem을 메우고 추가로 0.15rem(다른 칩들 사이 간격과 동일)
				// 만큼 눈에 보이는 여백을 더 둔다.
				const dayLaneCount = Math.max(0, ...bands.filter((b) => b.startCol <= day && day <= b.endCol).map((b) => b.lane + 1));
				const chipsWrapper = cell.createDiv({ cls: "lilac-cell-chips" });
				chipsWrapper.style.marginTop = `${dayLaneCount * laneHeightRem + 0.25}rem`;
				const entries = chipsByCol.get(day) ?? [];
				const visible = entries.slice(0, maxChipsPerDay);
				for (const entry of visible) this.renderEventChip(chipsWrapper, entry, laneHeightRem);
				if (entries.length > visible.length) {
					chipsWrapper.createDiv({ cls: "lilac-cell-more", text: `+${entries.length - visible.length}` });
				}

				// 전역(월 전체) 레인 수와 이 칸 기준 레인 수 차이만큼을 칩 *아래* 트레일링
				// 스페이서로 돌려, 모든 주의 셀 총 높이는 그대로 같게 유지하면서도 빈
				// 공백은 밴드-칩 사이가 아니라 셀 맨 아래로 옮긴다.
				const slack = laneCount - dayLaneCount;
				if (slack > 0) {
					const spacer = cell.createDiv({ cls: "lilac-cell-band-slack" });
					spacer.style.height = `${slack * laneHeightRem}rem`;
				}
			}

			// Bands are created after the cells so they paint on top (raised z-index in
			// styles.css). `position: absolute` (Claude Design 목업 사양, 2026-06-22) —
			// an absolutely-positioned grid child still resolves `grid-column` against the
			// grid's tracks but takes up no space in auto-placement, so it can't shove the
			// day cells into a phantom row the way an in-flow band could. `top` (not
			// `margin-top`) stacks lanes from the grid area's own top edge, offset by
			// `DATE_ROW_OFFSET_REM + lane * LANE_HEIGHT_REM` so it floats directly under the
			// date number; `left:0; right:0` (with the class's `margin: 0 0.3rem` inset)
			// stretches it across the full column span instead of shrinking to fit its text.
			for (const band of bands) {
				const el = weekEl.createDiv({ cls: "lilac-band" });
				if (!band.isStart) el.addClass("lilac-band-continues-left");
				if (!band.isEnd) el.addClass("lilac-band-continues-right");
				el.style.gridColumn = `${band.startCol + 1} / ${band.endCol + 2}`;
				el.style.left = "0";
				el.style.right = "0";
				el.style.top = `${DATE_ROW_OFFSET_REM + band.lane * laneHeightRem + 0.1}rem`;
				el.style.height = `${laneHeightRem}rem`;
				if (band.category) {
					el.style.setProperty("--lilac-chip-color", lighten(band.category.color, CHIP_BG_LIGHTEN));
					el.style.setProperty("--lilac-chip-text", darken(band.category.color, CHIP_TEXT_DARKEN));
				}
				el.setText(band.item.title);
				el.onclick = (e) => {
					e.stopPropagation();
					void this.openItemTarget(band.item);
				};
			}
		});
	}

	/** Day number; padding cells from adjacent months show "M/D" to orient the user. */
	private formatDateLabel(date: Date): string {
		if (date.getMonth() !== this.currentMonth) {
			return `${date.getMonth() + 1}/${date.getDate()}`;
		}
		return String(date.getDate());
	}

	/** Multi-day occurrences within this week, packed into non-overlapping lanes (greedy interval packing). */
	private placeBands(occurrences: Occurrence[], weekStart: Date, weekStartISO: string, weekEndISO: string): BandPlacement[] {
		const spanning = occurrences
			.filter((o) => o.startISO !== o.endISO && o.endISO >= weekStartISO && o.startISO <= weekEndISO)
			.map((o) => {
				const rawStart = this.dayOffset(weekStart, o.startISO);
				const rawEnd = this.dayOffset(weekStart, o.endISO);
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
	 * Todos are intentionally absent here — they're summarized into the day badge instead.
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

	/**
	 * For every date in the visible grid, picks the longest-spanning occurrence covering
	 * that day (ties broken by earliest start) — that occurrence's category drives the
	 * cell tile's own background tint (see `CELL_TINT_LIGHTEN`). Sorting once and only
	 * filling in dates that aren't already claimed is cheaper than comparing per-day
	 * across all occurrences, and naturally gives "longest wins, earliest-start breaks
	 * ties" since that's the sort order.
	 */
	private buildCellTints(occurrences: Occurrence[], gridStartISO: string, gridEndISO: string): Map<string, Occurrence> {
		const sorted = [...occurrences].sort(
			(a, b) => this.durationDays(b) - this.durationDays(a) || a.startISO.localeCompare(b.startISO)
		);
		const map = new Map<string, Occurrence>();
		for (const occ of sorted) {
			const start = occ.startISO < gridStartISO ? gridStartISO : occ.startISO;
			const end = occ.endISO > gridEndISO ? gridEndISO : occ.endISO;
			for (let d = parseISO(start); toISO(d) <= end; d = addDays(d, 1)) {
				const iso = toISO(d);
				if (!map.has(iso)) map.set(iso, occ);
			}
		}
		return map;
	}

	private durationDays(occ: Occurrence): number {
		return Math.round((parseISO(occ.endISO).getTime() - parseISO(occ.startISO).getTime()) / 86_400_000) + 1;
	}

	private dayOffset(weekStart: Date, iso: string): number {
		// weekStart carries whatever time-of-day `new Date()` had when the view was opened,
		// while parseISO(iso) is always midnight — normalize to midnight before diffing so
		// the day count is always exact (see lilac DECISIONS 2026-06-07, date-offset bug).
		const weekStartMidnight = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
		return Math.round((parseISO(iso).getTime() - weekStartMidnight.getTime()) / 86_400_000);
	}

	/** A single-day event shown by name — same visual language as a band, just not grid-spanned. */
	private renderEventChip(container: HTMLElement, occ: Occurrence, laneHeightRem: number): void {
		const chip = container.createDiv({ cls: "lilac-event-chip" });
		// PC 슬라이더로 글자가 커져도 박스(min-height)가 같은 비율로 같이 커져야
		// 잘려 보이지 않는다 — band의 `el.style.height`와 같은 이유.
		chip.style.minHeight = `${laneHeightRem}rem`;
		if (occ.category) {
			chip.style.setProperty("--lilac-chip-color", lighten(occ.category.color, CHIP_BG_LIGHTEN));
			chip.style.setProperty("--lilac-chip-text", darken(occ.category.color, CHIP_TEXT_DARKEN));
		}
		const text = occ.item.schedule_kind === "time" && occ.item.time_start ? `${occ.item.time_start} ${occ.item.title}` : occ.item.title;
		chip.setText(text);
		chip.onclick = (e) => {
			e.stopPropagation();
			void this.openItemTarget(occ.item);
		};
	}

	/**
	 * Todomate의 클로버 배지 참고(`~/lilac/sample/todosreenshot.jpg`)로 처음엔 겹친 원 4개로
	 * 꽃잎 모양을 만들었으나, 겹친 원은 나중에 그려진 것이 먼저 그려진 것을 가려 색이
	 * 2개 이상이어도 실제로는 한 색만 보이는 문제가 있었음(사용자 보고, 2026-06-22) —
	 * 특히 24라운드에 배지를 1.4rem→1.1rem으로 줄인 뒤 겹치는 비율이 커져 더 심해짐.
	 * 원 하나에 `conic-gradient`(2색 이상, 끝 색=시작 색으로 닫아 이어지는 자리도 부드럽게)
	 * 또는 `radial-gradient`(1색, 살짝 광택)를 직접 칠하는 방식으로 교체 — 겹침 자체가
	 * 없는 구조라 색 개수와 무관하게 항상 정확히 다 보인다.
	 */
	private renderTodoBadge(topRow: HTMLElement, summary: TodoDaySummary): void {
		const badge = topRow.createDiv({ cls: "lilac-todo-badge" });
		if (summary.colors.length === 1) {
			const c = summary.colors[0];
			badge.style.background = `radial-gradient(circle at 30% 30%, ${lighten(c, 0.35)}, ${c})`;
		} else if (summary.colors.length > 1) {
			const stops = [...summary.colors, summary.colors[0]].join(", ");
			badge.style.background = `conic-gradient(${stops})`;
		} // else: 카테고리 없음 → CSS 기본값(테마 accent 색)이 그대로 적용됨
		const symbol = badge.createDiv({ cls: "lilac-todo-badge-symbol" });
		if (summary.pending > 0) {
			symbol.setText(String(summary.pending));
		} else {
			badge.addClass("lilac-todo-badge-done");
			symbol.setText("✓");
		}
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
