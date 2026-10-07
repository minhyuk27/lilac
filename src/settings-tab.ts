import { App, PluginSettingTab, Setting } from "obsidian";
import type LilacPlugin from "../main";
import { Category } from "./types";
import { loadCategories, saveCategories } from "./categories";
import { Holiday, loadCustomHolidays, saveCustomHolidays } from "./holidays";
import { toISO } from "./dates";
import type { LilacSettings } from "./settings";

/** "여행" -> "travel-1719..." (한글도 안전하게 보존, 충돌 시 타임스탬프로 구분). */
function slugify(name: string): string {
	const base = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9가-힣]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return base || `category-${Date.now()}`;
}

const DEFAULT_NEW_COLOR = "#888888";

/**
 * Categories.md를 직접 YAML로 편집하지 않고도 카테고리(일정 종류)별 이름·기본 색·
 * 캘린더 노출 여부를 설정할 수 있는 탭(사용자 요청, 2026-06-21: "플러그인 설정 만들고
 * 거기에서 일정 종류나 기본값 색 등등 설정"). 저장은 항상 `Categories.md` frontmatter로
 * — 이 탭도 다른 항목들과 마찬가지로 마크다운이 원본이라는 SPEC 원칙을 그대로 따른다.
 */
export class LilacSettingTab extends PluginSettingTab {
	private categories: Category[] = [];
	private persistTimer: number | undefined;
	// 저장을 항상 한 줄로 줄세워 실행 — 디바운스 타이머가 겹치더라도(예: 이름 입력 중
	// 색도 같이 바꾸는 경우) 두 `processFrontMatter` 호출이 동시에 같은 파일을 읽고
	// 쓰다가 서로의 변경을 덮어쓰는 경쟁 상태를 막는다.
	private persistChain: Promise<void> = Promise.resolve();
	// 방금 추가한 카테고리의 id — render() 후 그 행의 이름 입력칸에 자동 포커스를 주기
	// 위해 한 번만 쓰고 비운다.
	private justAddedId: string | null = null;

	// 휴일 — 카테고리와 완전히 같은 디바운스/줄세우기 패턴이지만 별도 파일(Holidays.md)에
	// 저장되므로 타이머/체인을 분리해둔다(하나가 카테고리 저장을 밀어내거나 그 반대가
	// 되는 일이 없게).
	private customHolidays: Holiday[] = [];
	private holidaysPersistTimer: number | undefined;
	private holidaysPersistChain: Promise<void> = Promise.resolve();
	private justAddedHolidayIndex: number | null = null;

	constructor(app: App, private plugin: LilacPlugin) {
		super(app, plugin);
	}

	display(): void {
		this.categories = loadCategories(this.app);
		this.customHolidays = loadCustomHolidays(this.app);
		this.render();
	}

	// 사용자가 이름을 입력하다가(디바운스 대기 중) 설정 탭을 벗어나면(다른 설정 페이지로
	// 이동, 설정 창 닫기 등) Obsidian이 hide()를 호출한다. 이때 대기 중인 디바운스
	// 타이머를 그대로 두면 다음에 settings를 다시 열 때 display()가 디스크의 옛 값을
	// 다시 읽어와 this.categories를 통째로 교체해버려 — 아직 디스크에 안 쓰인 타이핑이
	// 조용히 사라지고 빈 이름("")이 그대로 굳어버리는 버그가 있었다(실제로 발생: 새
	// 카테고리 2개가 이름 없이 저장된 채 발견됨). hide() 시점에 대기 중인 저장을 즉시
	// 실행해 이 경쟁을 없앤다.
	hide(): void {
		if (this.persistTimer) {
			window.clearTimeout(this.persistTimer);
			this.persistTimer = undefined;
			void this.persist();
		}
		if (this.holidaysPersistTimer) {
			window.clearTimeout(this.holidaysPersistTimer);
			this.holidaysPersistTimer = undefined;
			void this.persistHolidays();
		}
		if (this.settingsSaveTimer) {
			window.clearTimeout(this.settingsSaveTimer);
			this.settingsSaveTimer = undefined;
			void this.plugin.saveSettings();
			this.plugin.refreshViews();
		}
	}

	private render(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h3", { text: "캘린더 화면" });

		// 기존엔 캘린더 패널의 실제 폭만 보고 모바일/PC를 자동 판단했는데, 태블릿이나
		// 특정 상황(예: 데스크톱 창을 좁게 쓰면서도 PC 밀도를 유지하고 싶은 경우)에는
		// 자동 판단이 안 맞을 수 있어 직접 강제할 수 있게 함(사용자 요청, 2026-08-15:
		// "태블릿이나 상황에 따라 내가 직접 설정 가능하게"). 이 설정은 옵시디언 앱
		// 자체가 모바일 클라이언트인지(뒤에 나오는 몰입형 헤더 여부)와는 무관 — 순전히
		// 칸 크기/글자 크기/한 칸에 보이는 일정 개수 같은 레이아웃 밀도만 결정한다.
		new Setting(containerEl)
			.setName("화면 밀도")
			.setDesc("캘린더 칸 크기와 글자 크기를 결정하는 기준. 자동은 캘린더 패널의 실제 폭으로 판단하고, 나머지는 폭과 무관하게 그 밀도로 고정합니다.")
			.addDropdown((d) =>
				d
					.addOption("auto", "자동 (패널 폭 기준)")
					.addOption("mobile", "모바일")
					.addOption("tablet", "태블릿")
					.addOption("desktop", "PC")
					.setValue(this.plugin.settings.deviceMode)
					.onChange((v) => {
						this.plugin.settings.deviceMode = v as LilacSettings["deviceMode"];
						void this.plugin.saveSettings();
						this.plugin.refreshViews();
					})
			);

		// PC에서 캘린더 패널이 넓을 때 일정 이름 글자가 작아 보인다는 보고(2026-06-22)에
		// 자동 브레이크포인트로 대응했었으나, 화면/패널 크기마다 "적당한 크기"가 달라
		// 자동으로는 안 맞았음 — 사용자가 직접 슬라이더로 조절. 제목/요일/날짜 숫자는
		// 이 슬라이더와 무관(같은 보고, "캘린더 글자라는게 제목이나 이런게 아니라 달력
		// 안에 일정들 이름이 작게 보여") — 칩/밴드(일정 이름) 글자에만 적용된다.
		new Setting(containerEl)
			.setName("PC 캘린더 일정 이름 글자 크기")
			.setDesc("캘린더 패널이 넓을 때(PC) 칸 안 일정 이름(칩/기간 일정 막대) 글자 크기를 조절합니다. 제목·요일·날짜 숫자나 모바일 크기에는 영향이 없습니다.")
			.addSlider((s) =>
				s
					.setLimits(80, 200, 5)
					.setValue(this.plugin.settings.calendarPcFontScale)
					.setDynamicTooltip()
					.onChange((v) => {
						this.plugin.settings.calendarPcFontScale = v;
						this.scheduleSettingsSave();
					})
			);

		containerEl.createEl("h3", { text: "카테고리 (일정 종류)" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "캘린더에 표시되는 색과 노출 여부를 카테고리별로 정합니다. 변경 즉시 Categories.md에 저장됩니다.",
		});

		for (const category of this.categories) this.renderCategoryRow(containerEl, category);

		new Setting(containerEl).addButton((b) =>
			b
				.setButtonText("+ 카테고리 추가")
				.setCta()
				.onClick(() => {
					const name = "새 카테고리";
					const id = slugify(name + Date.now());
					this.categories.push({ id, name, color: DEFAULT_NEW_COLOR, calendar_visible: true });
					this.justAddedId = id;
					void this.persist();
					this.render();
				})
		);

		containerEl.createEl("h3", { text: "휴일" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			// 신정/현충일은 대체공휴일 대상이 아니라 그대로, 나머지 6개는 토·일요일과
			// 겹치면 대체공휴일까지 자동으로 계산해 붙는다(holidays.ts 참고) — 그래서
			// 아래 목록은 그 계산으로 커버되지 않는(음력 기준) 휴일만 사용자가 직접
			// 추가하면 된다.
			text: "신정·삼일절·어린이날·현충일·광복절·개천절·한글날·성탄절과 그 대체공휴일은 자동으로 계산되어 캘린더에 표시됩니다. 설날·추석·부처님오신날처럼 음력 기준으로 매년 날짜가 바뀌는 휴일과 그 대체공휴일은 아래에 직접 추가해주세요.",
		});

		this.customHolidays.forEach((holiday, i) => this.renderHolidayRow(containerEl, holiday, i));

		new Setting(containerEl).addButton((b) =>
			b
				.setButtonText("+ 휴일 추가")
				.setCta()
				.onClick(() => {
					this.customHolidays.push({ date: toISO(new Date()), name: "" });
					this.justAddedHolidayIndex = this.customHolidays.length - 1;
					void this.persistHolidays();
					this.render();
				})
		);
	}

	private renderCategoryRow(containerEl: HTMLElement, category: Category): void {
		// 정적 라벨(setName)을 따로 두면 바로 옆 입력칸과 같은 텍스트를 중복 표시하면서도
		// 라벨 자신은 편집되지 않아 "이름을 눌렀는데 안 바뀐다"는 혼동을 줄 수 있다 —
		// 카테고리 행은 라벨 없이 입력칸 자체가 이름을 보여주고 편집하게 한다.
		const setting = new Setting(containerEl);

		setting.addText((t) => {
			t.setValue(category.name)
				.setPlaceholder("이름")
				.onChange((v) => {
					category.name = v;
					// 텍스트 입력은 키 누를 때마다 onChange가 발생 — 그대로 즉시 저장하면
					// 빠르게 타이핑하는 동안 겹쳐 실행되는 여러 processFrontMatter 호출이
					// 서로의 결과를 덮어쓸 위험이 있어 디바운스(실제 저장은 hide()에서도
					// 한 번 더 강제로 흘려보냄 — 위 hide() 주석 참고).
					this.schedulePersist();
				});
			// 입력칸을 벗어나는 순간(다른 필드 클릭, 탭 전환 등) 대기 중인 디바운스를
			// 즉시 흘려보낸다 — hide()와 같은 이유의 안전망이지만 설정 탭을 안 벗어나도
			// (같은 페이지에서 다른 행을 만지는 경우도) 작동하도록 별도로 둔다.
			t.inputEl.addEventListener("blur", () => {
				// 비워두고 떠나면 빈 이름이 그대로 저장되어 캘린더/모달 카테고리
				// 목록에 빈 항목이 보이게 된다 — 빈 채로 두면 기본 이름으로 되돌린다.
				if (category.name.trim() === "") category.name = "새 카테고리";
				if (this.persistTimer) {
					window.clearTimeout(this.persistTimer);
					this.persistTimer = undefined;
					void this.persist();
				}
			});
			if (category.id === this.justAddedId) {
				this.justAddedId = null;
				// 막 추가한 행은 사용자가 바로 이어서 이름을 입력하려는 경우가 대부분 —
				// 입력칸을 직접 찾아 클릭해야 하는 수고를 없애고, 기본값("새 카테고리")이
				// 전체 선택된 상태로 포커스를 줘서 타이핑하면 곧장 교체되게 한다.
				window.setTimeout(() => {
					t.inputEl.focus();
					t.inputEl.select();
				}, 0);
			}
		});

		setting.addColorPicker((c) =>
			c.setValue(category.color).onChange((v) => {
				category.color = v;
				this.schedulePersist();
			})
		);

		setting.addToggle((t) =>
			t
				.setTooltip("캘린더에 표시")
				.setValue(category.calendar_visible)
				.onChange((v) => {
					category.calendar_visible = v;
					this.schedulePersist();
				})
		);

		setting.addExtraButton((b) =>
			b
				.setIcon("trash")
				.setTooltip("삭제")
				.onClick(() => {
					// 카테고리 삭제는 되돌리기 번거로운 동작(이 카테고리를 쓰던 모든 항목이
					// 색을 잃음)이라 — 가벼운 확인을 한 번 거친다.
					if (!window.confirm(`"${category.name}" 카테고리를 삭제할까요? 이 카테고리를 쓰던 일정/할일은 기본 색으로 표시됩니다.`)) return;
					this.categories = this.categories.filter((c) => c.id !== category.id);
					void this.persist();
					this.render();
				})
		);
	}

	/** 카테고리 행(renderCategoryRow)과 같은 모양 — 라벨 없이 입력칸 두 개(날짜/이름) +
	 * 삭제 버튼. 날짜는 캘린더처럼 커스텀 피커를 쓰지 않고 그냥 텍스트 입력으로 뒀다 —
	 * 이 목록은 1년에 몇 번 건드릴까 말까 한 설날/추석류 몇 줄이 전부라, item-modal의
	 * 자체 제작 피커(모바일 네이티브 date input의 들쭉날쭉한 생김새 때문에 만든 것)까지
	 * 끌어올 만한 곳이 아니다. */
	private renderHolidayRow(containerEl: HTMLElement, holiday: Holiday, index: number): void {
		const setting = new Setting(containerEl);

		setting.addText((t) => {
			t.setValue(holiday.date)
				.setPlaceholder("YYYY-MM-DD")
				.onChange((v) => {
					holiday.date = v;
					this.scheduleHolidayPersist();
				});
			t.inputEl.addEventListener("blur", () => this.flushHolidayPersist());
		});

		setting.addText((t) => {
			t.setValue(holiday.name)
				.setPlaceholder("예: 설날")
				.onChange((v) => {
					holiday.name = v;
					this.scheduleHolidayPersist();
				});
			t.inputEl.addEventListener("blur", () => this.flushHolidayPersist());
			if (index === this.justAddedHolidayIndex) {
				this.justAddedHolidayIndex = null;
				window.setTimeout(() => t.inputEl.focus(), 0);
			}
		});

		setting.addExtraButton((b) =>
			b
				.setIcon("trash")
				.setTooltip("삭제")
				.onClick(() => {
					this.customHolidays = this.customHolidays.filter((_, i) => i !== index);
					void this.persistHolidays();
					this.render();
				})
		);
	}

	private scheduleHolidayPersist(): void {
		if (this.holidaysPersistTimer) window.clearTimeout(this.holidaysPersistTimer);
		this.holidaysPersistTimer = window.setTimeout(() => void this.persistHolidays(), 400);
	}

	private flushHolidayPersist(): void {
		if (!this.holidaysPersistTimer) return;
		window.clearTimeout(this.holidaysPersistTimer);
		this.holidaysPersistTimer = undefined;
		void this.persistHolidays();
	}

	private async persistHolidays(): Promise<void> {
		this.holidaysPersistChain = this.holidaysPersistChain.then(() => saveCustomHolidays(this.app, this.customHolidays));
		await this.holidaysPersistChain;
	}

	private schedulePersist(): void {
		if (this.persistTimer) window.clearTimeout(this.persistTimer);
		this.persistTimer = window.setTimeout(() => void this.persist(), 400);
	}

	private async persist(): Promise<void> {
		this.persistChain = this.persistChain.then(() => saveCategories(this.app, this.categories));
		await this.persistChain;
	}

	private settingsSaveTimer: number | undefined;

	/** 슬라이더를 드래그하는 동안 매 입력마다 저장/리렌더하지 않게 디바운스 — 카테고리
	 * 텍스트 입력의 `schedulePersist`와 같은 이유. */
	private scheduleSettingsSave(): void {
		if (this.settingsSaveTimer) window.clearTimeout(this.settingsSaveTimer);
		this.settingsSaveTimer = window.setTimeout(() => {
			void this.plugin.saveSettings();
			this.plugin.refreshViews();
		}, 300);
	}
}
