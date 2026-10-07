import { App, Modal, Notice, Setting, TFile, setIcon } from "obsidian";
import type LilacPlugin from "../main";
import { LilacItem, Recurrence, ScheduleKind } from "./types";
import { updateItemFields } from "./frontmatter";
import { generateFolderIndex } from "./index-note";
import { lighten, darken, CHIP_BG_LIGHTEN, CHIP_TEXT_DARKEN } from "./color";
import { addDays, parseISO, startOfWeek, toISO, todayISO } from "./dates";
import { enableWheelHorizontalScroll } from "./dom";

const ITEMS_FOLDER = "lilac/items";

/** "[[일본여행/index|일본여행]]" -> "일본여행"; 폴더-index 링크가 아니면 null. */
function parseFolderIndexLink(link: string | null): string | null {
	if (!link) return null;
	const m = /^\[\[(.+)\/index(\|[^\]]*)?\]\]$/.exec(link.trim());
	return m ? m[1] : null;
}

/** routine-list-modal.ts도 요일 코드→한글 라벨 매핑에 그대로 재사용(export, 2026-08-16). */
export const WEEKDAY_OPTIONS: { code: string; label: string }[] = [
	{ code: "MO", label: "월" },
	{ code: "TU", label: "화" },
	{ code: "WE", label: "수" },
	{ code: "TH", label: "목" },
	{ code: "FR", label: "금" },
	{ code: "SA", label: "토" },
	{ code: "SU", label: "일" },
];

/** Strips characters that can't appear in a filename; falls back if the title is empty/symbols-only. */
function slugifyTitle(title: string): string {
	const cleaned = title.trim().replace(/[\\/:*?"<>|#^[\]]/g, "");
	return cleaned.slice(0, 80) || "제목 없음";
}

async function uniquePath(app: App, folder: string, title: string): Promise<string> {
	const base = slugifyTitle(title);
	let path = `${folder}/${base}.md`;
	let i = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = `${folder}/${base} (${i}).md`;
		i++;
	}
	return path;
}

interface FormState {
	type: "schedule" | "todo";
	title: string;
	category: string; // "" = 없음
	link: string;
	linkToFolder: boolean;
	folderPath: string;
	memo: string;
	// schedule
	scheduleKind: ScheduleKind;
	start: string;
	end: string;
	timeStart: string;
	timeEnd: string;
	calendarVisible: "default" | "show" | "hide";
	recurrenceOn: boolean;
	recurrenceDays: Set<string>;
	recurrenceUntil: string;
	// todo
	due: string;
	doDate: string;
}

function buildInitialState(existing: LilacItem | undefined, defaultDate: string | undefined): FormState {
	const folderFromLink = parseFolderIndexLink(existing?.link ?? null);

	if (existing?.type === "schedule") {
		return {
			type: "schedule",
			title: existing.title,
			category: existing.category ?? "",
			link: existing.link ?? "",
			linkToFolder: folderFromLink !== null,
			folderPath: folderFromLink ?? "",
			memo: existing.memo ?? "",
			scheduleKind: existing.schedule_kind,
			start: existing.start ?? "",
			end: existing.end ?? "",
			timeStart: existing.time_start ?? "",
			timeEnd: existing.time_end ?? "",
			calendarVisible: existing.calendar_visible === null ? "default" : existing.calendar_visible ? "show" : "hide",
			recurrenceOn: !!existing.recurrence,
			recurrenceDays: new Set(existing.recurrence?.days ?? []),
			recurrenceUntil: existing.recurrence?.until ?? "",
			due: "",
			doDate: "",
		};
	}
	if (existing?.type === "todo") {
		return {
			type: "todo",
			title: existing.title,
			category: existing.category ?? "",
			link: existing.link ?? "",
			linkToFolder: folderFromLink !== null,
			folderPath: folderFromLink ?? "",
			memo: existing.memo ?? "",
			scheduleKind: "day",
			start: "",
			end: "",
			timeStart: "",
			timeEnd: "",
			calendarVisible: "default",
			recurrenceOn: false,
			recurrenceDays: new Set(),
			recurrenceUntil: "",
			due: existing.due ?? "",
			doDate: existing.do_date ?? "",
		};
	}
	return {
		type: "schedule",
		title: "",
		category: "",
		link: "",
		linkToFolder: false,
		folderPath: "",
		memo: "",
		scheduleKind: "day",
		start: defaultDate ?? "",
		end: "",
		timeStart: "",
		timeEnd: "",
		calendarVisible: "default",
		recurrenceOn: false,
		recurrenceDays: new Set(),
		recurrenceUntil: "",
		due: defaultDate ?? "",
		doDate: "",
	};
}

/**
 * SPEC §3.2/§4의 "항목 추가 모달" — schedule이면 kind별 필드, todo면 마감/실행일. 같은
 * 폼으로 편집·삭제도 처리한다. DB(sql.js)는 읽기 캐시일 뿐이라 이 모달이 직접 건드리는
 * 대상은 항상 마크다운 파일 하나 — 새 항목은 `lilac/items/`에 빈 frontmatter로 파일을
 * 만든 뒤 `updateItemFields`로 채우고, 기존 항목은 그 파일에 바로 `updateItemFields`.
 */
export class LilacItemModal extends Modal {
	private state: FormState;
	private bodyEl!: HTMLElement;
	private titleInputEl: HTMLInputElement | null = null;

	constructor(
		app: App,
		private plugin: LilacPlugin,
		private opts: { existing?: LilacItem; defaultDate?: string; onSaved?: () => void } = {}
	) {
		super(app);
		this.state = buildInitialState(opts.existing, opts.defaultDate);
	}

	onOpen(): void {
		// 한국어 번역("일정"/"할일")이 아니라 영단어 그대로 — 사용자가 명시적으로
		// 요청(2026-06-21, 21라운드에서 "구분"/"일정 형식"으로 중복 라벨을 분리했는데도
		// 또 요청이 와서 직접 확인: 번역이 아니라 "Schedule"/"Todo"라는 단어 자체를 원함).
		this.titleEl.setText(this.opts.existing ? "Schedule/Todo 수정" : "Schedule/Todo 추가");
		this.contentEl.addClass("lilac-item-modal");
		this.render();
		// 데일리노트(lilac-daily 코드블록)의 "+"/✎ 버튼으로 모달을 열면, 그 버튼을 클릭한
		// 직후 라이브 프리뷰 에디터가 자기 자신에게 포커스를 되돌리려는 타이밍과 모달이
		// 열리는 타이밍이 겹쳐 — 제목 입력칸을 클릭해도 전혀 반응이 없는(포커스를 못 받는)
		// 간헐적 증상으로 보고됨("처음엔 안 되다가 다시 해보면 갑자기 됨" — 정확히 경합
		// 조건의 특징). 모달이 화면에 자리잡은 다음 틱에 제목칸에 직접 포커스를 줘서
		// 에디터의 포커스 복원이 먼저 끝난 뒤 우리가 마지막으로 포커스를 가져가게 한다.
		window.setTimeout(() => this.titleInputEl?.focus(), 50);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/**
	 * 다른 앱(구글캘린더/Todoist류)의 일정 추가 팝업처럼 — 옵시디언 기본 설정 화면의
	 * "라벨+한 줄 컨트롤" 목록 대신, 큰 제목 입력·세그먼트 버튼(구분/일정 형식)·색이
	 * 입혀진 카테고리 칩·아이콘이 붙은 행으로 다시 구성했다(사용자 요청, 2026-08-15:
	 * "다른 어플처럼 팝업 형식이나 직관적으로 UI 따로 이쁘게"). 값 바인딩 자체는 여전히
	 * Obsidian의 `Setting`(addText/addToggle 등, 테마와 자동으로 맞는 네이티브 입력)에
	 * 맡기고 — `fieldRow()`로 아이콘+래퍼만 감싸는 방식이라 검증된 값 바인딩 로직은
	 * 그대로 재사용하면서 겉모습만 바꿨다.
	 */
	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		if (!this.opts.existing) {
			// "구분"(일정 vs 할일)과 아래 schedule 전용 "일정 형식"(하루/기간/시간)이
			// 둘 다 "종류"라는 같은 단어를 쓰면 폼을 채울 때 "방금 그거 또 묻나?"
			// 헷갈림 — 서로 다른 단어로 분리(사용자 요청, 2026-06-21: "네이밍 통일
			// 및 정리"). 드롭다운 대신 큰 세그먼트 버튼 두 개로 — 새 항목을 만들 때
			// 가장 먼저 결정하는 값이라 한눈에 보이는 게 자연스럽다.
			const typeSwitch = contentEl.createDiv({ cls: "lilac-modal-type-switch" });
			const scheduleBtn = typeSwitch.createEl("button", {
				cls: `lilac-modal-type-btn${this.state.type === "schedule" ? " is-active" : ""}`,
				text: "Schedule",
			});
			const todoBtn = typeSwitch.createEl("button", {
				cls: `lilac-modal-type-btn${this.state.type === "todo" ? " is-active" : ""}`,
				text: "Todo",
			});
			scheduleBtn.onclick = () => {
				this.state.type = "schedule";
				this.render();
			};
			todoBtn.onclick = () => {
				this.state.type = "todo";
				this.render();
			};
		}

		// 제목 — 구글캘린더 "제목 추가"처럼 라벨 없이 큰 글자의 플레이스홀더 입력칸
		// 하나만. `Setting`을 안 쓰는 유일한 텍스트 필드라 `titleInputEl`도 직접 잡는다
		// (31라운드 포커스 경합 수정이 이 요소를 대상으로 하므로 동작은 그대로 유지).
		const titleInput = contentEl.createEl("input", {
			cls: "lilac-modal-title-input",
			attr: { type: "text", placeholder: "제목을 입력하세요" },
		});
		titleInput.value = this.state.title;
		titleInput.oninput = () => (this.state.title = titleInput.value);
		this.titleInputEl = titleInput;

		this.renderCategoryChips(contentEl);

		this.bodyEl = contentEl.createDiv({ cls: "lilac-modal-body" });
		this.renderTypeFields();

		const linkRow = this.fieldRow(contentEl, "link", "폴더에 연결");
		new Setting(linkRow)
			.setDesc("저장 시 그 폴더의 문서 목록을 모은 index 노트를 자동 생성/갱신하고 거기로 링크합니다 (SPEC §4 #9).")
			.addToggle((t) =>
				t.setValue(this.state.linkToFolder).onChange((v) => {
					this.state.linkToFolder = v;
					this.render();
				})
			);

		const linkSub = contentEl.createDiv({ cls: "lilac-modal-subrow" });
		if (this.state.linkToFolder) {
			new Setting(linkSub).setName("폴더 경로").setDesc("예: 일본여행").addText((t) =>
				t.setValue(this.state.folderPath).onChange((v) => (this.state.folderPath = v))
			);
		} else {
			new Setting(linkSub).setName("링크").setDesc("[[노트명]] 형식, 비워둘 수 있음").addText((t) =>
				t.setValue(this.state.link).onChange((v) => (this.state.link = v))
			);
		}

		// 연결된 문서(링크/항목 노트)와는 별개 — 문서를 안 열어도 데일리노트에서 바로
		// 보이는 한두 줄짜리 메모(사용자 요청, 2026-06-21). schedule/todo 둘 다 공통.
		const memoRow = this.fieldRow(contentEl, "file-text", "메모");
		new Setting(memoRow)
			.setDesc("문서를 열지 않아도 데일리노트에 바로 보이는 짧은 비고")
			.addText((t) => t.setValue(this.state.memo).onChange((v) => (this.state.memo = v)));

		const buttons = contentEl.createDiv({ cls: "lilac-item-modal-buttons" });
		if (this.opts.existing) {
			const del = buttons.createEl("button", { cls: "lilac-item-modal-delete", text: "삭제" });
			del.onclick = () => void this.handleDelete();
		}
		const cancel = buttons.createEl("button", { cls: "lilac-modal-btn-cancel", text: "취소" });
		cancel.onclick = () => this.close();
		const submit = buttons.createEl("button", { cls: "mod-cta", text: this.opts.existing ? "저장" : "만들기" });
		submit.onclick = () => void this.handleSubmit();
	}

	/**
	 * 아이콘 + 컨트롤 한 행 — 값 바인딩은 호출부가 반환된 엘리먼트 안에 `Setting`을
	 * 붙여서 한다. 두 가지 모양:
	 * - `label` 없음(카테고리 칩/세그먼트 버튼처럼 항상 한 줄로 끝나는 내용): 아이콘과
	 *   내용을 그냥 나란히, `align-items: center`로 충분히 맞는다.
	 * - `label` 있음(날짜/시간/토글처럼 `Setting`을 쓰는 행): 좁은 화면에서 옵시디언이
	 *   `Setting`의 라벨과 입력칸을 스스로 두 줄로 쌓아버리면(예: 날짜 입력칸), 아이콘을
	 *   그 "라벨+입력칸 전체 블록"의 세로 중앙에 맞추면 라벨 쪽으로 안 맞고 그 사이
	 *   틈에 걸쳐 라벨이 아이콘보다 위로 떠 보였다(사용자 보고, 2026-08-15 스크린샷:
	 *   "날짜, 매주반복 글씨가 반칸 위에 있어"). 아이콘과 라벨을 아예 같은 줄
	 *   (`.lilac-modal-row-head`)에 묶어 항상 서로 정확히 맞물리게 하고, `Setting`이
	 *   그리는 입력칸(들쭉날쭉하게 쌓일 수 있는 부분)은 그 아래 별도 줄로 완전히
	 *   분리 — 어떤 화면 폭에서 입력칸이 몇 줄로 쌓이든 아이콘-라벨 관계는 항상
	 *   고정이라 다시는 이 종류의 버그가 날 수 없는 구조. `Setting` 자신이 만드는
	 *   `.setting-item-name`(라벨)은 이제 중복이라 CSS로 숨긴다(`styles.css`
	 *   `.lilac-modal-row-control .setting-item-name`).
	 */
	private fieldRow(parent: HTMLElement, icon: string, label?: string): HTMLElement {
		const row = parent.createDiv({ cls: "lilac-modal-row" });
		if (label !== undefined) {
			row.addClass("lilac-modal-row-labeled");
			const head = row.createDiv({ cls: "lilac-modal-row-head" });
			const iconEl = head.createDiv({ cls: "lilac-modal-row-icon" });
			setIcon(iconEl, icon);
			head.createSpan({ cls: "lilac-modal-row-label", text: label });
			return row.createDiv({ cls: "lilac-modal-row-control" });
		}
		const iconEl = row.createDiv({ cls: "lilac-modal-row-icon" });
		setIcon(iconEl, icon);
		return row.createDiv({ cls: "lilac-modal-row-content" });
	}

	/**
	 * 카테고리를 밋밋한 드롭다운 텍스트 대신, 캘린더 칩과 완전히 같은 색 공식
	 * (`CHIP_BG_LIGHTEN`/`CHIP_TEXT_DARKEN`, color.ts)으로 칠한 알약 버튼으로 —
	 * 캘린더에서 본 색과 모달에서 고르는 색이 항상 같아 보인다. 선택은 즉시
	 * `is-active` 링만 갱신하고 전체 `render()`를 다시 하지 않는다(구조가 안 바뀌는
	 * 단순 값 선택이라 — 다른 입력칸의 포커스/스크롤을 굳이 잃을 이유가 없다).
	 */
	private renderCategoryChips(parent: HTMLElement): void {
		const categories = this.plugin.getDatabase()?.getCategories() ?? [];
		const content = this.fieldRow(parent, "tag");
		content.addClass("lilac-modal-category-row");
		enableWheelHorizontalScroll(content);

		const chips: { id: string; el: HTMLElement }[] = [];
		const setActive = () => {
			for (const { id, el } of chips) el.toggleClass("is-active", this.state.category === id);
		};

		const noneChip = content.createEl("button", { cls: "lilac-modal-category-chip", text: "없음" });
		noneChip.onclick = () => {
			this.state.category = "";
			setActive();
		};
		chips.push({ id: "", el: noneChip });

		for (const c of categories) {
			const chip = content.createEl("button", { cls: "lilac-modal-category-chip", text: c.name });
			chip.style.setProperty("--lilac-chip-color", lighten(c.color, CHIP_BG_LIGHTEN));
			chip.style.setProperty("--lilac-chip-text", darken(c.color, CHIP_TEXT_DARKEN));
			chip.onclick = () => {
				this.state.category = c.id;
				setActive();
			};
			chips.push({ id: c.id, el: chip });
		}

		setActive();
	}

	private renderTypeFields(): void {
		this.bodyEl.empty();
		if (this.state.type === "schedule") this.renderScheduleFields(this.bodyEl);
		else this.renderTodoFields(this.bodyEl);
	}

	/** 세그먼트 버튼 그룹 — 라벨 없이 알약 버튼끼리 나란히(구분/일정 형식 세그먼트와 같은 언어). */
	private segmented<T extends string>(
		parent: HTMLElement,
		options: { value: T; label: string }[],
		current: T,
		onSelect: (value: T) => void
	): void {
		const row = parent.createDiv({ cls: "lilac-modal-segmented" });
		for (const { value, label } of options) {
			const btn = row.createEl("button", {
				cls: `lilac-modal-segmented-btn${value === current ? " is-active" : ""}`,
				text: label,
			});
			btn.onclick = () => onSelect(value);
		}
	}

	/** "2026. 8. 16." — 월/일 앞자리 0 없음(ISO를 그대로 치환하면 "08"처럼 0이 남음). */
	private static formatDateValue(v: string): string {
		if (!v) return "날짜 선택";
		const [y, m, d] = v.split("-").map(Number);
		return `${y}. ${m}. ${d}.`;
	}

	/**
	 * 날짜 입력을 브라우저/OS 기본 `<input type=date>`(안드로이드 버전·테마마다
	 * 생김새가 제각각)에 맡기지 않고, 캘린더뷰(calendar-view.ts)와 같은 월간 그리드를
	 * 이 모달 안에 직접 그려 항상 같은 모습으로 통일했다(사용자 요청, 2026-08-16:
	 * "날짜, 시간 등 설정하는 방법 직접 만들어서 항상 일관성 있고 깔끔하게"). 값을
	 * 보여주는 버튼을 누르면 그 아래 달력이 펼쳐지고(다른 필드를 다시 렌더하지 않는
	 * 로컬 상태라 포커스/스크롤 안 잃음), 날짜를 고르면 즉시 접힌다.
	 */
	private renderDatePicker(parent: HTMLElement, icon: string, label: string, value: string, onChange: (v: string) => void): void {
		this.renderDatePickerInto(this.fieldRow(parent, icon, label), value, onChange);
	}

	/**
	 * `renderDatePicker`의 아이콘 없는 버전 — `.lilac-modal-subrow`(예: "반복 종료일")
	 * 처럼 이미 캡션만 보여주는 자리에 아이콘 열을 또 넣으면 이중 들여쓰기로 보여서
	 * 분리(사용자가 직접 짚은 건 아니지만, "반복 요일" 캡션 바로 아래 같은 결로
	 * 맞추는 게 자연스러움). 실제 달력 로직은 여기 한 곳에만 있다.
	 */
	private renderDatePickerInto(control: HTMLElement, value: string, onChange: (v: string) => void): void {
		const row = control.createDiv({ cls: "lilac-date-picker-row" });
		const trigger = row.createEl("button", { cls: "lilac-date-picker-trigger", attr: { type: "button" } });
		const triggerText = trigger.createSpan({ cls: "lilac-date-picker-trigger-text" });
		setIcon(trigger.createDiv({ cls: "lilac-date-picker-chevron" }), "chevron-down");
		// 마감일/실행 계획일/종료일 등은 원래 비워둘 수 있는 값인데, 한 번 날짜를
		// 고르고 나면 다시 빈 값으로 되돌릴 방법이 없었다(사용자 보고, 2026-08-16:
		// "마감일이나 계획일 등 공란으로 둘 수 있게 할 방법 필요해") — 값이 있을
		// 때만 보이는 × 버튼으로 즉시 지울 수 있게.
		const clearBtn = row.createEl("button", { cls: "lilac-date-picker-clear", attr: { type: "button" }, text: "×" });

		let current = value;
		let expanded = false;
		const initial = value ? parseISO(value) : new Date();
		let viewYear = initial.getFullYear();
		let viewMonth = initial.getMonth();

		const updateTrigger = (v: string) => {
			triggerText.setText(LilacItemModal.formatDateValue(v));
			clearBtn.toggleClass("is-visible", v !== "");
		};
		updateTrigger(value);

		const closePanel = () => {
			expanded = false;
			trigger.removeClass("is-open");
			panel.hide();
		};

		clearBtn.onclick = (e) => {
			e.stopPropagation();
			current = "";
			onChange("");
			updateTrigger("");
			closePanel();
		};

		const panel = control.createDiv({ cls: "lilac-date-picker-panel" });
		panel.hide();

		const renderGrid = () => {
			panel.empty();
			const nav = panel.createDiv({ cls: "lilac-date-picker-nav" });
			const prev = nav.createEl("button", { cls: "lilac-nav-btn", attr: { type: "button" }, text: "‹" });
			nav.createDiv({ cls: "lilac-date-picker-label", text: `${viewYear}년 ${viewMonth + 1}월` });
			const next = nav.createEl("button", { cls: "lilac-nav-btn", attr: { type: "button" }, text: "›" });
			prev.onclick = (e) => {
				e.stopPropagation();
				viewMonth--;
				if (viewMonth < 0) {
					viewMonth = 11;
					viewYear--;
				}
				renderGrid();
			};
			next.onclick = (e) => {
				e.stopPropagation();
				viewMonth++;
				if (viewMonth > 11) {
					viewMonth = 0;
					viewYear++;
				}
				renderGrid();
			};

			const grid = panel.createDiv({ cls: "lilac-date-picker-grid" });
			for (const wd of ["일", "월", "화", "수", "목", "금", "토"]) {
				grid.createDiv({ cls: "lilac-date-picker-weekday", text: wd });
			}

			const gridStart = startOfWeek(new Date(viewYear, viewMonth, 1));
			const gridEndAnchor = addDays(startOfWeek(new Date(viewYear, viewMonth + 1, 0)), 6);
			const numDays = Math.round((gridEndAnchor.getTime() - gridStart.getTime()) / 86_400_000) + 1;
			const todayStr = todayISO();

			for (let i = 0; i < numDays; i++) {
				const date = addDays(gridStart, i);
				const iso = toISO(date);
				const cell = grid.createEl("button", { cls: "lilac-date-picker-cell", attr: { type: "button" }, text: String(date.getDate()) });
				if (date.getMonth() !== viewMonth) cell.addClass("is-other-month");
				if (iso === todayStr) cell.addClass("is-today");
				if (iso === current) cell.addClass("is-selected");
				cell.onclick = (e) => {
					e.stopPropagation();
					current = iso;
					onChange(iso);
					updateTrigger(iso);
					closePanel();
				};
			}
		};

		trigger.onclick = () => {
			expanded = !expanded;
			trigger.toggleClass("is-open", expanded);
			if (expanded) {
				renderGrid();
				panel.show();
			} else {
				panel.hide();
			}
		};
	}

	/**
	 * 시간 입력도 날짜와 같은 이유로 직접 만듦 — `<input type=time>`은 기기마다
	 * 휠/스피너/텍스트 등 UI 자체가 달라 "일관성 있게"라는 요청과 정면으로
	 * 안 맞았음. 시(0~23)·분(5분 단위) 두 가로 스크롤 알약 줄에서 골라 즉시
	 * "HH:MM"으로 합쳐 반영 — 카테고리 칩(2026-08-16, 같은 세션 이전 라운드)과
	 * 같은 가로 스크롤 패턴이라 새로운 상호작용을 배울 필요가 없다.
	 */
	private renderTimePicker(parent: HTMLElement, icon: string, label: string, value: string, onChange: (v: string) => void): void {
		const control = this.fieldRow(parent, icon, label);
		const row = control.createDiv({ cls: "lilac-date-picker-row" });
		const trigger = row.createEl("button", { cls: "lilac-date-picker-trigger", attr: { type: "button" } });
		const triggerText = trigger.createSpan({ cls: "lilac-date-picker-trigger-text" });
		setIcon(trigger.createDiv({ cls: "lilac-date-picker-chevron" }), "chevron-down");
		// 날짜와 같은 이유 — "종료 시간 (선택)"처럼 비워둘 수 있는 필드를 한 번
		// 고른 뒤 다시 비울 방법이 필요했음(2026-08-16 요청).
		const clearBtn = row.createEl("button", { cls: "lilac-date-picker-clear", attr: { type: "button" }, text: "×" });
		triggerText.setText(value || "시간 선택");
		clearBtn.toggleClass("is-visible", value !== "");
		const panel = control.createDiv({ cls: "lilac-date-picker-panel" });
		panel.hide();

		let [hour, minute] = value ? value.split(":").map(Number) : [9, 0];
		minute = Math.round(minute / 5) * 5;
		let expanded = false;

		const closePanel = () => {
			expanded = false;
			trigger.removeClass("is-open");
			panel.hide();
		};

		clearBtn.onclick = (e) => {
			e.stopPropagation();
			onChange("");
			triggerText.setText("시간 선택");
			clearBtn.removeClass("is-visible");
			closePanel();
		};

		const applyChange = () => {
			const v = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
			onChange(v);
			triggerText.setText(v);
			clearBtn.addClass("is-visible");
		};

		const renderPanel = () => {
			panel.empty();

			panel.createDiv({ cls: "lilac-time-picker-label", text: "시" });
			const hourRow = panel.createDiv({ cls: "lilac-time-picker-row" });
			enableWheelHorizontalScroll(hourRow);
			for (let h = 0; h < 24; h++) {
				const cell = hourRow.createEl("button", { cls: "lilac-time-picker-cell", attr: { type: "button" }, text: String(h).padStart(2, "0") });
				cell.toggleClass("is-active", h === hour);
				cell.onclick = (e) => {
					e.stopPropagation();
					hour = h;
					applyChange();
					renderPanel();
				};
			}

			panel.createDiv({ cls: "lilac-time-picker-label", text: "분" });
			const minuteRow = panel.createDiv({ cls: "lilac-time-picker-row" });
			enableWheelHorizontalScroll(minuteRow);
			for (let m = 0; m < 60; m += 5) {
				const cell = minuteRow.createEl("button", { cls: "lilac-time-picker-cell", attr: { type: "button" }, text: String(m).padStart(2, "0") });
				cell.toggleClass("is-active", m === minute);
				cell.onclick = (e) => {
					e.stopPropagation();
					minute = m;
					applyChange();
					renderPanel();
				};
			}
		};

		trigger.onclick = () => {
			expanded = !expanded;
			trigger.toggleClass("is-open", expanded);
			if (expanded) {
				renderPanel();
				panel.show();
			} else {
				panel.hide();
			}
		};
	}

	private renderScheduleFields(parent: HTMLElement): void {
		// "일정 형식"은 이 아래 어떤 날짜/시간 칸이 보일지를 바꾸는 구조적 선택이라
		// `renderTypeFields()`로 다시 그린다(기존 드롭다운의 onChange와 동일한 동작).
		// 다른 행들과 달리 아이콘 없이 맨 앞에 떠 있어 결만 다르게 보였음(사용자 보고,
		// 2026-08-15: "이것만 맨 앞 아이콘이 없네") — `fieldRow`로 감싸 다른 아이콘
		// 행들과 같은 리듬(들여쓰기·상하 여백)을 쓰게 한다.
		const kindRow = this.fieldRow(parent, "calendar-range");
		kindRow.addClass("lilac-modal-inline-segmented");
		this.segmented(
			kindRow,
			[
				{ value: "day" as ScheduleKind, label: "하루" },
				{ value: "period" as ScheduleKind, label: "기간" },
				{ value: "time" as ScheduleKind, label: "시간" },
			],
			this.state.scheduleKind,
			(v) => {
				this.state.scheduleKind = v;
				this.renderTypeFields();
			}
		);

		if (this.state.scheduleKind === "period") {
			this.renderDatePicker(parent, "calendar-days", "시작일", this.state.start, (v) => (this.state.start = v));
			this.renderDatePicker(parent, "calendar-days", "종료일", this.state.end, (v) => (this.state.end = v));
		} else {
			this.renderDatePicker(parent, "calendar-days", "날짜", this.state.start, (v) => (this.state.start = v));
			if (this.state.scheduleKind === "time") {
				this.renderTimePicker(parent, "clock", "시작 시간", this.state.timeStart, (v) => (this.state.timeStart = v));
				this.renderTimePicker(parent, "clock", "종료 시간 (선택)", this.state.timeEnd, (v) => (this.state.timeEnd = v));
			}
		}

		// 노출 3단계도 값 선택일 뿐 구조가 안 바뀌므로 전체 재렌더 없이 세그먼트만 갱신.
		const visRow = this.fieldRow(parent, "eye");
		visRow.addClass("lilac-modal-inline-segmented");
		this.segmented(
			visRow,
			[
				// "카테고리 기본값" 전체 문구는 좁은 모바일 폭에서 세그먼트 버튼 폭을
				// 밀어내는 원인 중 하나였음(사용자 보고, 2026-08-15: "요소들이 줄바꿈이
				// 되거나") — 이 값 앞에 이미 "눈" 아이콘이 붙어 문맥이 있으므로 축약.
				{ value: "default" as FormState["calendarVisible"], label: "기본값" },
				{ value: "show" as FormState["calendarVisible"], label: "항상 표시" },
				{ value: "hide" as FormState["calendarVisible"], label: "항상 숨김" },
			],
			this.state.calendarVisible,
			(v) => {
				this.state.calendarVisible = v;
				this.renderTypeFields();
			}
		);

		// 44라운드에 Todomate처럼 "반복" 행 → 별도 전체화면 하위 뷰로 바꿨었으나,
		// 사용자 재보고(2026-08-16): "루틴을 추가하기 위해 버튼을 두 번 눌러야
		// 하는 문제"(카드 탭 → 토글 탭, 2번), "반복사용/종료일 글자가 일부만
		// 세로로 나타나는 문제"(카드 안 Setting 레이아웃이 좁은 폭에서 깨짐),
		// "근본적으로 못생겼어", "기존처럼 토글로 나타나게 하는게 좋을거 같아.
		// 별도 팝업창은 별로" — 전체화면 드릴다운을 포기하고 43라운드의 인라인
		// 토글+조건부 목록 방식으로 되돌림(토글 한 번으로 바로 켜짐, 별도 화면 없음).
		const recurRow = this.fieldRow(parent, "repeat", "매주 반복");
		new Setting(recurRow).addToggle((t) =>
			t.setValue(this.state.recurrenceOn).onChange((v) => {
				this.state.recurrenceOn = v;
				this.renderTypeFields();
			})
		);

		if (this.state.recurrenceOn) {
			const sub = parent.createDiv({ cls: "lilac-modal-subrow" });
			sub.createDiv({ cls: "lilac-modal-row-label", text: "반복 요일" });
			const daysRow = sub.createDiv({ cls: "lilac-weekday-row" });
			for (const { code, label } of WEEKDAY_OPTIONS) {
				const btn = daysRow.createEl("button", { cls: "lilac-weekday-toggle", text: label });
				btn.toggleClass("is-active", this.state.recurrenceDays.has(code));
				btn.onclick = () => {
					if (this.state.recurrenceDays.has(code)) this.state.recurrenceDays.delete(code);
					else this.state.recurrenceDays.add(code);
					btn.toggleClass("is-active", this.state.recurrenceDays.has(code));
				};
			}
			sub.createDiv({ cls: "lilac-modal-row-label", text: "반복 종료일" });
			this.renderDatePickerInto(sub, this.state.recurrenceUntil, (v) => (this.state.recurrenceUntil = v));
		}
	}

	private renderTodoFields(parent: HTMLElement): void {
		this.renderDatePicker(parent, "flag", "마감일 (선택)", this.state.due, (v) => (this.state.due = v));
		this.renderDatePicker(parent, "calendar-check", "실행 계획일 (선택)", this.state.doDate, (v) => (this.state.doDate = v));
		parent.createDiv({ cls: "lilac-item-modal-hint", text: "둘 다 비워두면 '상시 할일'로 분류됩니다." });
	}

	private resolvedLink(): string | null {
		if (this.state.linkToFolder) {
			const folder = this.state.folderPath.trim().replace(/\/+$/, "");
			return folder ? `[[${folder}/index|${folder.split("/").pop()}]]` : null;
		}
		return this.state.link.trim() || null;
	}

	private buildFrontmatter(): Record<string, unknown> {
		const common = {
			lilac: true,
			type: this.state.type,
			title: this.state.title.trim(),
			category: this.state.category || null,
			link: this.resolvedLink(),
			memo: this.state.memo.trim() || null,
		};
		if (this.state.type === "schedule") {
			const recurrence: Recurrence | null = this.state.recurrenceOn
				? { freq: "weekly", days: Array.from(this.state.recurrenceDays), until: this.state.recurrenceUntil || null }
				: null;
			return {
				...common,
				schedule_kind: this.state.scheduleKind,
				start: this.state.start || null,
				end: this.state.scheduleKind === "period" ? this.state.end || null : null,
				time_start: this.state.scheduleKind === "time" ? this.state.timeStart || null : null,
				time_end: this.state.scheduleKind === "time" ? this.state.timeEnd || null : null,
				calendar_visible: this.state.calendarVisible === "default" ? null : this.state.calendarVisible === "show",
				recurrence,
			};
		}
		const existingTodo = this.opts.existing?.type === "todo" ? this.opts.existing : null;
		return {
			...common,
			due: this.state.due || null,
			do_date: this.state.doDate || null,
			done: existingTodo?.done ?? false,
			done_date: existingTodo?.done_date ?? null,
		};
	}

	private async handleSubmit(): Promise<void> {
		if (!this.state.title.trim()) {
			new Notice("lilac: 제목을 입력하세요.");
			return;
		}
		if (this.state.type === "schedule" && !this.state.start) {
			new Notice("lilac: 날짜를 입력하세요.");
			return;
		}
		// 종료일이 시작일보다 빠르면 occurrence 전개 단계에서 조용히 사라져서(빈 구간으로
		// 처리됨) 캘린더/데일리노트 어디에도 안 보이는 채로 저장만 되는 게 가장 헷갈리는
		// 실패 모드였음 — 저장 시점에 바로 알려준다.
		if (this.state.type === "schedule" && this.state.scheduleKind === "period" && this.state.end && this.state.end < this.state.start) {
			new Notice("lilac: 종료일이 시작일보다 빠를 수 없습니다.");
			return;
		}
		// 반복을 켰는데 요일을 하나도 안 고르면 expandOccurrences가 빈 배열만 돌려줘서
		// "반복 설정했는데 캘린더엔 하나도 안 보임"으로만 드러남 — 저장 전에 미리 막음.
		if (this.state.type === "schedule" && this.state.recurrenceOn && this.state.recurrenceDays.size === 0) {
			new Notice("lilac: 반복 요일을 하나 이상 선택하세요.");
			return;
		}
		if (this.state.linkToFolder && !this.state.folderPath.trim()) {
			new Notice("lilac: 연결할 폴더 경로를 입력하세요.");
			return;
		}

		const fields = this.buildFrontmatter();
		let path: string;

		if (this.opts.existing) {
			path = this.opts.existing.path;
			await updateItemFields(this.app, path, fields);
		} else {
			if (!this.app.vault.getAbstractFileByPath(ITEMS_FOLDER)) {
				await this.app.vault.createFolder(ITEMS_FOLDER).catch(() => undefined);
			}
			path = await uniquePath(this.app, ITEMS_FOLDER, this.state.title);
			const file = await this.app.vault.create(path, "---\n---\n");
			await updateItemFields(this.app, file.path, fields);
		}

		if (this.state.linkToFolder && this.state.folderPath.trim()) {
			await generateFolderIndex(this.app, this.state.folderPath.trim());
		}

		// `metadataCache`의 "changed" 이벤트(main.ts)가 비동기로 인덱스를 갱신하기 전에
		// `onSaved`(예: 데일리노트 블록의 `refresh`)가 먼저 DB를 다시 읽으면, 방금 막 쓴
		// 내용이 아직 인덱스에 반영 안 된 옛 상태를 보여줄 수 있다(레이스 컨디션) — 같은
		// 내용을 여기서 즉시 직접 반영해 그 틈을 없앤다. 이벤트 리스너가 나중에 같은
		// 내용으로 다시 upsert해도 결과는 같으므로(멱등) 중복 호출은 안전하다.
		this.plugin.getDatabase()?.upsertItem({ path, ...fields } as unknown as LilacItem);

		this.opts.onSaved?.();
		this.close();
	}

	private async handleDelete(): Promise<void> {
		if (!this.opts.existing) return;
		if (!window.confirm(`"${this.opts.existing.title}"을 삭제할까요? 노트는 휴지통으로 이동합니다.`)) return;
		const file = this.app.vault.getAbstractFileByPath(this.opts.existing.path);
		if (file instanceof TFile) await this.app.fileManager.trashFile(file);
		this.plugin.getDatabase()?.deleteItem(this.opts.existing.path);
		this.opts.onSaved?.();
		this.close();
	}
}
