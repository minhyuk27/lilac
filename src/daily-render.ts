import { App, TFile, setIcon } from "obsidian";
import type LilacPlugin from "../main";
import { Category, ScheduleItem, TodoItem } from "./types";
import { addDays, parseISO, toISO, todayISO } from "./dates";
import { buildOccurrences, Occurrence } from "./occurrences";
import { chipTextColor } from "./color";
import { updateItemFields } from "./frontmatter";
import { LilacItemModal } from "./item-modal";
import { LilacStickyModal } from "./sticky-modal";
import { openDailyNote } from "./daily-note";

const LOOKAHEAD_DAYS = 7;
const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

/** "6월 21일 (일)" — "오늘"이면 그것도 덧붙여 전날/다음날로 옮겨다닐 때도 길을 잃지 않게. */
export function formatDailyDateLabel(dateISO: string): string {
	const date = parseISO(dateISO);
	const base = `${date.getMonth() + 1}월 ${date.getDate()}일 (${WEEKDAY_LABELS[date.getDay()]})`;
	return dateISO === todayISO() ? `${base} · 오늘` : base;
}

/** A todo's "effective date" — same convention as the calendar's day badge (do_date wins, else due). */
function effectiveDate(todo: TodoItem): string | null {
	return todo.do_date ?? todo.due;
}

function byEffectiveDateThenTitle(a: TodoItem, b: TodoItem): number {
	return (effectiveDate(a) ?? "").localeCompare(effectiveDate(b) ?? "") || a.title.localeCompare(b.title);
}

/** "[[folder/note|alias]]" -> "folder/note"; plain paths pass through untouched. */
function extractLinkpath(link: string): string {
	const match = link.match(/\[\[([^\]|]+)/);
	return match ? match[1].trim() : link;
}

async function openItemTarget(app: App, item: ScheduleItem | TodoItem): Promise<void> {
	const linkpath = item.link ? extractLinkpath(item.link) : item.path;
	const dest = app.metadataCache.getFirstLinkpathDest(linkpath, item.path) ?? app.vault.getAbstractFileByPath(item.path);
	if (dest instanceof TFile) await app.workspace.getLeaf(false).openFile(dest);
}

/**
 * Renders the `lilac-daily` code block for one daily note. Registered from main.ts's
 * `registerMarkdownCodeBlockProcessor`, which already resolved the note's date via
 * `getDateFromFile`. SPEC §3.2's six sections, minus the free-text memo (that's a plain
 * "## 메모" heading the template puts below this block — this function never touches it).
 */
export async function renderDailyBlock(app: App, plugin: LilacPlugin, dateISO: string, el: HTMLElement): Promise<void> {
	el.addClass("lilac-daily-block");

	// 코드블록은 frontmatter 변경에 자동 재렌더되지 않으므로, 모달이 저장된 뒤 같은 자리에서
	// 다시 그려준다(체크박스의 낙관적 업데이트와 같은 이유 — main.ts의 metadataCache 리스너는
	// DB와 캘린더뷰는 갱신하지만 이미 렌더된 이 블록까지는 손대지 않는다).
	const refresh = () => {
		el.empty();
		void renderDailyBlock(app, plugin, dateISO, el);
	};

	// 날짜 이동 줄 — 전날/다음날 사이에 지금 보고 있는 날짜를 항상 보여준다. 버튼만
	// 있으면 옆 날짜로 넘어간 뒤 "오늘이 며칠이지?"를 노트 제목까지 눈을 옮겨야
	// 확인해야 했음(특히 분할 화면에서 제목이 안 보이는 경우) — 라벨로 바로 보이게.
	const dateNav = el.createDiv({ cls: "lilac-daily-toolbar lilac-daily-datenav" });
	dateNav.createEl("button", { cls: "lilac-nav-btn", text: "‹" }).onclick = () =>
		void openDailyNote(app, addDays(parseISO(dateISO), -1));
	dateNav.createDiv({ cls: "lilac-daily-date-label", text: formatDailyDateLabel(dateISO) });
	dateNav.createEl("button", { cls: "lilac-nav-btn", text: "›" }).onclick = () =>
		void openDailyNote(app, addDays(parseISO(dateISO), 1));

	const toolbar = el.createDiv({ cls: "lilac-daily-toolbar" });
	// 모바일 기기 back 버튼/제스처가 leaf 히스토리를 못 타는 경우를 대비한 확실한
	// 복귀 경로(사용자 보고, 2026-06-21: "모바일 뒤로가기 여전히 안돼"). 캘린더뷰가
	// 이미 열려 있으면 그 탭으로, 없으면 새로 열어서 보여준다(main.ts openCalendarView).
	toolbar.createEl("button", { cls: "lilac-nav-btn", text: "← Calendar" }).onclick = () =>
		void plugin.openCalendarView();
	toolbar.createEl("button", { cls: "lilac-nav-btn lilac-add-btn", text: "+ Schedule/Todo" }).onclick = () =>
		new LilacItemModal(app, plugin, { defaultDate: dateISO, onSaved: refresh }).open();
	// 캘린더 헤더의 스티키노트 버튼과 같은 아이콘으로 통일(사용자 요청, 2026-06-22:
	// "dailynote의 스티키노트도 통일").
	const stickyBtn = toolbar.createEl("button", { cls: "lilac-nav-btn lilac-sticky-btn" });
	setIcon(stickyBtn, "sticky-note");
	stickyBtn.onclick = () => new LilacStickyModal(app, plugin).open();
	// 임의 날짜의 노트를 보다가도 오늘로 바로 돌아갈 수 있게(사용자 요청, 2026-08-24:
	// "오늘 dailynote바로가기도 만들어줘") — 위 ‹›는 하루씩만 옮기지만 이건 어느 날짜에서든
	// 한 번에 오늘로.
	if (dateISO !== todayISO()) {
		const todayBtn = toolbar.createEl("button", { cls: "lilac-nav-btn" });
		setIcon(todayBtn, "calendar-check");
		todayBtn.onclick = () => void openDailyNote(app, new Date());
	}

	renderDailySections(app, plugin, dateISO, el, refresh);
}

/**
 * 그 날의 목록(Schedule/Todo/Due/Overdue/Planned/Always/Finished) — 데일리노트 블록과
 * 사이드바(sidebar-view.ts)가 **같은 함수**를 써서, 같은 할일이 어디서 보든 똑같이
 * 보이고 똑같이 동작하게 한다(2026-10-07, 50라운드). 날짜 줄·도구 줄은 각자 다르므로
 * 호출하는 쪽이 그린다. `refresh`는 체크·편집 뒤 호출자가 자기 화면을 다시 그리는 방법.
 */
export function renderDailySections(
	app: App,
	plugin: LilacPlugin,
	dateISO: string,
	el: HTMLElement,
	refresh: () => void,
	emptyText = "오늘은 일정도 할일도 없습니다."
): void {
	const db = plugin.getDatabase();
	if (!db) {
		el.createDiv({ cls: "lilac-day-detail-empty", text: "lilac 인덱스를 불러오는 중입니다." });
		return;
	}

	const categoryById = new Map(db.getCategories().map((c) => [c.id, c]));
	const occurrences = buildOccurrences(
		db.getScheduleItemsOverlapping(dateISO, dateISO),
		categoryById,
		dateISO,
		dateISO,
		() => true // 데일리노트는 calendar_visible과 무관하게 그날의 일정을 전부 보여준다 (SPEC §3.2 #1).
	)
		.filter((o) => dateISO >= o.startISO && dateISO <= o.endISO)
		.sort((a, b) => (a.item.time_start ?? "").localeCompare(b.item.time_start ?? "") || a.item.title.localeCompare(b.item.title));

	const lookaheadEndISO = toISO(addDays(parseISO(dateISO), LOOKAHEAD_DAYS));

	const todayTodos = db
		.getTodoItemsInRange(dateISO, dateISO)
		.filter((t) => !t.done && effectiveDate(t) === dateISO)
		.sort(byEffectiveDateThenTitle);
	const overdueTodos = db.getOpenTodosBefore(dateISO).sort(byEffectiveDateThenTitle);
	const upcomingTodos = db
		.getTodoItemsInRange(toISO(addDays(parseISO(dateISO), 1)), lookaheadEndISO)
		// effectiveDate (do_date ?? due) must itself fall strictly within the lookahead window —
		// the range query alone isn't enough: a todo whose `due` is in-window but whose `do_date`
		// (the effective date, since do_date wins) is earlier/overdue would otherwise show up
		// here *and* in "Overdue", duplicated.
		.filter((t) => {
			if (t.done) return false;
			const eff = effectiveDate(t);
			return eff !== null && eff > dateISO && eff <= lookaheadEndISO;
		})
		.sort(byEffectiveDateThenTitle);
	const standingTodos = db.getStandingTodos().sort((a, b) => a.title.localeCompare(b.title));
	// "완료 날짜 당김"(SPEC §4) 기록 — 계획일(do_date)이 며칠 뒤였어도 더 일찍 체크하면
	// 그 체크한 날에 기록되는데, 이 섹션이 없으면 체크 즉시 그 항목이 모든 데일리노트에서
	// 영원히 사라져서 "오늘 뭘 끝냈는지"가 그날 노트에 전혀 안 남는 빈틈이었음.
	const doneTodayTodos = db.getTodosDoneOn(dateISO).sort((a, b) => a.title.localeCompare(b.title));

	// 마감일(due)이 오늘이지만, 실행일(do_date)이 따로 있어(당겨서 미리 했거나, 계획을
	// 다른 날로 잡아둬서) effectiveDate(do_date ?? due) 기준으로는 이미 위 네 목록
	// 어디에도 안 걸리는 항목 — 예: 원래 마감이 오늘인 todo를 이틀 전에 당겨서 이미
	// 끝냈다면, done=true라 today/overdue/upcoming(전부 `!done` 필터)엔 안 잡히고
	// done_date도 오늘이 아니라 그날이라 "Finished"에도 안 잡혀서, 정작 마감일인
	// 오늘 노트엔 그 todo 흔적이 전혀 안 남았다(사용자 보고, 2026-08-21: "21일 할
	// todo를 19일에 당겨서 진행했는데 21엔 아무것도 안 보임 — 원래 21까지 해야하는
	// 일이니 이것도 표시되어야"). 이미 위 목록 중 하나에 잡힌 항목은 제외해 중복
	// 표시를 막는다(예: do_date가 지났는데 아직 미완료면 Overdue에 이미 나오므로
	// 여기 또 안 넣음).
	const alreadyListedPaths = new Set(
		[...todayTodos, ...overdueTodos, ...upcomingTodos, ...doneTodayTodos].map((t) => t.path)
	);
	const dueTodayTodos = db
		.getTodoItemsInRange(dateISO, dateISO)
		.filter((t) => t.due === dateISO && !alreadyListedPaths.has(t.path))
		.sort((a, b) => a.title.localeCompare(b.title));

	const isEmpty =
		occurrences.length === 0 &&
		todayTodos.length === 0 &&
		overdueTodos.length === 0 &&
		upcomingTodos.length === 0 &&
		standingTodos.length === 0 &&
		doneTodayTodos.length === 0 &&
		dueTodayTodos.length === 0;

	if (isEmpty) {
		el.createDiv({ cls: "lilac-day-detail-empty", text: emptyText });
		return;
	}

	if (occurrences.length > 0) {
		const section = renderSection(el, "🗓️", "Schedule");
		for (const occ of occurrences) renderScheduleRow(section, app, plugin, occ, refresh);
	}

	if (todayTodos.length > 0) {
		const section = renderSection(el, "✅", "Todo");
		for (const todo of todayTodos) renderTodoRow(section, app, plugin, categoryById, todo, dateISO, refresh);
	}

	if (dueTodayTodos.length > 0) {
		// 완료 여부와 무관하게 그대로 renderTodoRow에 맡긴다 — 이미 끝난 항목이면
		// `todo.done`이 true라 done_date 완료 라벨과 취소선이 자동으로 붙고, 아직이면
		// do_date/due가 다르다는 게 필터 조건이었으므로 항상 "do_date 실행 예정 / due
		// 마감" 라벨이 뜬다.
		const section = renderSection(el, "🔔", "Due");
		for (const todo of dueTodayTodos) renderTodoRow(section, app, plugin, categoryById, todo, dateISO, refresh);
	}

	if (overdueTodos.length > 0) {
		const section = renderSection(el, "⏰", "Overdue");
		for (const todo of overdueTodos) renderTodoRow(section, app, plugin, categoryById, todo, dateISO, refresh, { pullForward: true });
	}

	if (upcomingTodos.length > 0) {
		const section = renderSection(el, "🔭", "Planned");
		for (const todo of upcomingTodos) renderTodoRow(section, app, plugin, categoryById, todo, dateISO, refresh);
	}

	if (standingTodos.length > 0) {
		const section = renderSection(el, "♾️", "Always");
		for (const todo of standingTodos) renderTodoRow(section, app, plugin, categoryById, todo, dateISO, refresh);
	}

	if (doneTodayTodos.length > 0) {
		const section = renderSection(el, "🎉", "Finished");
		// 그냥 "완료했다"만 보여주면 원래 무슨 todo였는지(오늘 할 일이었는지, 상시였는지,
		// 다른 날 계획이었는지)가 사라짐 — 사용자 요청(2026-06-21)대로 작은 태그를 붙임.
		for (const todo of doneTodayTodos) {
			renderTodoRow(section, app, plugin, categoryById, todo, dateISO, refresh, { originalBucketLabel: originalBucketLabel(todo, dateISO) });
		}
	}
}

/** "Finished"에서 원래 어느 섹션의 todo였는지 — 섹션 이름과 맞춰 일관되게. */
function originalBucketLabel(todo: TodoItem, dateISO: string): string {
	if (todo.due === null && todo.do_date === null) return "Always";
	const eff = effectiveDate(todo);
	if (eff === dateISO) return "Todo";
	if (eff !== null && eff < dateISO) return "Overdue";
	return "Planned";
}

/** 섹션이 6개나 되니 훑어볼 때 제목 글자를 다 읽지 않고도 구분되게 — 아이콘 하나씩. */
function renderSection(parent: HTMLElement, icon: string, title: string): HTMLElement {
	const section = parent.createDiv({ cls: "lilac-daily-section" });
	const heading = section.createDiv({ cls: "lilac-daily-section-title" });
	heading.createSpan({ cls: "lilac-daily-section-icon", text: icon });
	heading.createSpan({ text: title });
	return section.createDiv({ cls: "lilac-daily-section-list" });
}

function renderEditButton(row: HTMLElement, app: App, plugin: LilacPlugin, item: Occurrence["item"] | TodoItem, refresh: () => void): void {
	const edit = row.createEl("button", { cls: "lilac-edit-btn", text: "✎" });
	edit.onclick = (e) => {
		e.stopPropagation();
		new LilacItemModal(app, plugin, { existing: item, onSaved: refresh }).open();
	};
}

function renderScheduleRow(parent: HTMLElement, app: App, plugin: LilacPlugin, occ: Occurrence, refresh: () => void): void {
	const row = parent.createDiv({ cls: "lilac-detail-row" });
	const dot = row.createDiv({ cls: "lilac-detail-dot" });
	if (occ.category) {
		dot.style.setProperty("--lilac-chip-color", occ.category.color);
		dot.style.setProperty("--lilac-chip-text", chipTextColor(occ.category.color));
	}
	const text = row.createDiv({ cls: "lilac-detail-text" });
	const timeLabel =
		occ.item.schedule_kind === "time" && occ.item.time_start
			? occ.item.time_start + (occ.item.time_end ? `–${occ.item.time_end}` : "")
			: occ.item.schedule_kind === "period" && occ.startISO !== occ.endISO
			? "기간 일정"
			: "종일";
	text.createSpan({ cls: "lilac-detail-time", text: timeLabel });
	// 제목+메모를 같은 flex-wrap 줄에 — PC처럼 넓으면 옆에, 모바일처럼 좁으면 자동으로
	// 아래 줄로 줄바꿈된다(미디어 쿼리 없이 flexbox 자체의 줄바꿈만으로, 사용자 요청
	// 2026-06-21: "pc기준으로는 일정 옆에, 모바일기준으로는 아래에").
	const titleRow = text.createDiv({ cls: "lilac-detail-title-row" });
	titleRow.createSpan({ cls: "lilac-detail-title", text: occ.item.title });
	if (occ.item.memo) titleRow.createSpan({ cls: "lilac-detail-memo", text: occ.item.memo });
	// 반복 일정의 개별 인스턴스 예외(SPEC §2.3 `recurrence.overrides`) — 강의실 변경처럼
	// "그 날만 다른" 각주. 지금까지는 데이터는 읽으면서도 화면 어디에도 안 보였던 빈틈.
	if (occ.note) text.createSpan({ cls: "lilac-detail-note", text: occ.note });
	row.onclick = () => void openItemTarget(app, occ.item);
	renderEditButton(row, app, plugin, occ.item, refresh);
}

function renderTodoRow(
	parent: HTMLElement,
	app: App,
	plugin: LilacPlugin,
	categoryById: Map<string, Category>,
	todo: TodoItem,
	dateISO: string,
	refresh: () => void,
	opts: { pullForward?: boolean; originalBucketLabel?: string } = {}
): void {
	const row = parent.createDiv({ cls: "lilac-detail-row lilac-detail-row-todo" });
	if (todo.done) row.addClass("lilac-detail-row-done");

	// 일정 행의 색 점과 같은 시각 언어 — todo도 카테고리별로 한눈에 구분되게(사용자
	// 요청, 2026-06-21: "todo도 schedule처럼 색깔로 구분할 수 있는 아이콘 필요").
	const category = todo.category ? categoryById.get(todo.category) ?? null : null;
	const dot = row.createDiv({ cls: "lilac-detail-dot" });
	if (category) {
		dot.style.setProperty("--lilac-chip-color", category.color);
		dot.style.setProperty("--lilac-chip-text", chipTextColor(category.color));
	}

	const checkbox = row.createEl("input", { type: "checkbox" });
	checkbox.checked = todo.done;
	checkbox.onclick = (e) => {
		e.stopPropagation();
		const checked = checkbox.checked;
		const fields = { done: checked, done_date: checked ? dateISO : null };
		void updateItemFields(app, todo.path, fields);
		// DB를 직접 갱신하고 블록 전체를 다시 그린다 — 이전엔 이 행만 지우는 낙관적
		// 업데이트(row.remove())였는데, 옵시디언이 파일 변경을 감지해 같은 블록을
		// 자체적으로 다시 렌더링하는 시점과 겹치면 "체크했는데 다시 나타나거나 빈
		// 화면이 되는" 비일관 상태가 됐다(사용자 보고, 2026-06-21: "눌러서 사라져서
		// 나갔다 들어와야 하는 증상"). DB를 먼저 확정해두고 같은 데이터로 우리가
		// 직접 다시 그리면, 옵시디언이 나중에 같은 파일로 또 다시 그려도 결과가
		// 똑같아 충돌이 없다.
		plugin.getDatabase()?.upsertItem({ ...todo, ...fields });
		refresh();
	};

	const text = row.createDiv({ cls: "lilac-detail-text" });
	const timeLabel = todo.done
		? opts.originalBucketLabel
			? `${todo.done_date} 완료 · 원래 ${opts.originalBucketLabel}`
			: `${todo.done_date} 완료`
		: todo.due && todo.do_date && todo.due !== todo.do_date
		? `${todo.do_date} 실행 예정 / ${todo.due} 마감`
		: todo.due
		? `${todo.due} 마감`
		: todo.do_date
		? `${todo.do_date} 실행 예정`
		: "상시";
	text.createSpan({ cls: "lilac-detail-time", text: timeLabel });
	const titleRow = text.createDiv({ cls: "lilac-detail-title-row" });
	titleRow.createSpan({ cls: "lilac-detail-title", text: todo.title });
	if (todo.memo) titleRow.createSpan({ cls: "lilac-detail-memo", text: todo.memo });

	if (opts.pullForward) {
		// 이 버튼은 do_date를 "실제 오늘"이 아니라 "지금 보고 있는 노트의 날짜"로
		// 당긴다 — 평소엔 같은 말이지만, 지난 날짜의 노트를 열어 보는 중이면 둘이
		// 달라서 "오늘로 당기기"라는 표현이 틀린 안내가 됨. 라벨을 상황에 맞게 바꿔
		// 혼동을 없앤다.
		const label = dateISO === todayISO() ? "오늘로 당기기" : "이 날로 당기기";
		const pull = row.createEl("button", { cls: "lilac-nav-btn lilac-pull-forward-btn", text: label });
		pull.onclick = (e) => {
			e.stopPropagation();
			void updateItemFields(app, todo.path, { do_date: dateISO });
			plugin.getDatabase()?.upsertItem({ ...todo, do_date: dateISO });
			refresh();
		};
	}
	renderEditButton(row, app, plugin, todo, refresh);
	// 일정 행(renderScheduleRow)과 동일하게 행 전체를 클릭 영역으로 — 체크박스/당기기/
	// 편집 버튼은 각자 stopPropagation으로 우선 처리되므로 텍스트 칸만 클릭되던
	// 이전의 일관성 없는 동작(2026-06-21, "calendar에서 dailynote 누르는 방식도
	// 일관되게" 요청과 같은 맥락에서 점검)을 바로잡음.
	row.onclick = () => void openItemTarget(app, todo);
}
