import { App, Modal } from "obsidian";
import type LilacPlugin from "../main";
import { STICKY_COLORS, StickyNote, createStickyNote, deleteStickyNote, listStickyNotes, setStickyColor, writeStickyBody } from "./sticky-notes";

const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * 잠깐 독립 탭(`LilacStickyView`)으로 바꿔봤으나(2026-08-24) 되돌림 — 사용자 요청,
 * 2026-08-27: "스티키 노트 원래 팝업이였잖아. 그걸로 해줘". 그 탭 버전에서 글 쓰는
 * 도중 계속 밀려나던 문제("나가져")의 원인도 이 되돌림으로 같이 해결된다: 캘린더/
 * 스티키뷰가 `main.ts`의 `refreshViews()`에 등록돼 있었는데, 스티키노트 자체가
 * 500ms 디바운스로 파일에 자동저장될 때마다 `metadataCache "changed"` 이벤트가 떠서
 * `onFileChanged` → `refreshViews()` → 스티키뷰의 `render()`가 다시 불려 `contentEl`을
 * 통째로 비우고 새로 그렸다 — 타이핑하려고 포커스를 두고 있던 바로 그 textarea가
 * 몇 초마다 파괴되고 새로 만들어지니 커서/포커스를 잃고 "나가지는" 것처럼 느껴졌다.
 * 모달은 `refreshViews()`가 아예 손대지 않는 대상이라(main.ts는 등록된 뷰 타입의 leaf만
 * 순회) 이 문제 자체가 구조적으로 발생할 수 없다.
 */
export class LilacStickyModal extends Modal {
	constructor(app: App, private plugin: LilacPlugin) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText("스티키노트");
		await this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/**
	 * "auto"면 지금 창의 실제 너비(캘린더뷰와 달리 모달은 늘 창 전체 기준으로 가운데
	 * 뜨는 대화상자라 패널 폭이 아니라 창 폭이 맞는 신호)로 판단, 설정 탭에서 강제
	 * 선택했으면 그 값을 그대로 — 캘린더뷰의 밀도 설정(`plugin.settings.deviceMode`)을
	 * 그대로 공유해 앱 전체가 한 가지 밀도 기준으로 맞게 한다(사용자 요청, 2026-08-27:
	 * "다른거처럼 pc,태블릿,모바일 ui 구분해서"). 문턱값은 calendar-view.ts와 동일.
	 */
	private resolveDeviceMode(): "mobile" | "tablet" | "desktop" {
		const forced = this.plugin.settings.deviceMode;
		if (forced !== "auto") return forced;
		const width = window.innerWidth;
		if (width >= 900) return "desktop";
		if (width >= 600) return "tablet";
		return "mobile";
	}

	private async render(): Promise<void> {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass("lilac-sticky-modal");
		// 모달 자체(바깥 대화상자) 너비/카드 크기를 밀도별로 다르게 — styles.css의
		// `.lilac-sticky-modal-shell[data-device=...]` 참고. PC에서 "너무 작다"는
		// 보고(2026-08-24)의 핵심 원인은 모든 밀도가 옵시디언 기본 모달 폭(안 그래도
		// 좁은 대화상자 하나)을 그대로 썼던 것 — PC에서는 훨씬 넓게, 카드도 크게 띄운다.
		modalEl.addClass("lilac-sticky-modal-shell");
		modalEl.dataset.device = this.resolveDeviceMode();

		const addBtn = contentEl.createEl("button", { cls: "lilac-sticky-add", text: "+ 새 메모" });
		const grid = contentEl.createDiv({ cls: "lilac-sticky-grid" });

		const notes = await listStickyNotes(this.app);
		for (const note of notes) this.renderCard(grid, note);

		addBtn.onclick = async () => {
			const note = await createStickyNote(this.app);
			const card = this.renderCard(grid, note);
			card.querySelector("textarea")?.focus();
		};
	}

	private renderCard(grid: HTMLElement, note: StickyNote): HTMLElement {
		const card = grid.createDiv({ cls: "lilac-sticky-card" });
		card.style.backgroundColor = note.color;

		// ×버튼은 카드 위에 절대위치로 떠 있으므로, textarea 쪽에 그만큼 위쪽 여백을
		// 줘서 글자 첫 줄과 겹치지 않게 한다(사용자 보고, 2026-06-21: "x버튼과 글
		// 겹치는 문제") — 버튼 쪽 크기가 바뀌어도 항상 충분히 비워두도록 넉넉하게.
		const closeBtn = card.createEl("button", { cls: "lilac-sticky-delete", text: "×" });
		const textarea = card.createEl("textarea", { cls: "lilac-sticky-textarea" });
		textarea.value = note.body;
		textarea.placeholder = "메모를 적어두세요...";
		// 브라우저(Electron) 기본 맞춤법 검사가 짧은 메모에도 빨간 물결 밑줄을 그려
		// 넣는 게 오타 표시처럼 거슬린다는 보고(2026-08-24) — 자유 메모라 정식 문서
		// 표기법을 따를 이유가 없어 꺼둔다.
		textarea.spellcheck = false;
		// 모바일 키보드가 올라오면 화면 아래쪽 카드는 그 밑에 가려서 지금 뭘 쓰고
		// 있는지 안 보인다는 보고(2026-09-07) — 포커스 시점엔 아직 키보드가 다 안
		// 올라와 있어 그때 바로 스크롤하면 목표 위치가 틀어진다. `visualViewport`가
		// 있으면(옵시디언 모바일의 웹뷰는 지원) 키보드가 실제로 다 올라와 뷰포트 높이가
		// 줄어드는 그 순간(resize 이벤트)에 맞춰 스크롤하고, 없는 환경에서만 고정
		// 지연시간(키보드 애니메이션 대략적인 길이)으로 대체한다.
		textarea.addEventListener("focus", () => {
			const scrollToView = () => textarea.scrollIntoView({ block: "center", behavior: "smooth" });
			const vv = window.visualViewport;
			if (vv) {
				vv.addEventListener("resize", scrollToView, { once: true });
				textarea.addEventListener("blur", () => vv.removeEventListener("resize", scrollToView), { once: true });
			} else {
				window.setTimeout(scrollToView, 300);
			}
		});

		// 색 스와치 — 생성 시 무작위로 고른 색을 나중에 바꿀 수 있게(사용자 요청,
		// 2026-06-21). ×버튼과 같은 줄(카드 위쪽)에 두면 또 겹칠 수 있어 카드 맨
		// 아래에 별도 줄로 둠.
		const swatches = card.createDiv({ cls: "lilac-sticky-swatches" });
		for (const color of STICKY_COLORS) {
			const swatch = swatches.createEl("button", { cls: "lilac-sticky-swatch" });
			swatch.style.backgroundColor = color;
			swatch.toggleClass("is-active", color === note.color);
			swatch.onclick = (e) => {
				e.stopPropagation();
				note.color = color;
				card.style.backgroundColor = color;
				swatches.querySelectorAll(".lilac-sticky-swatch").forEach((el) => el.removeClass("is-active"));
				swatch.addClass("is-active");
				void setStickyColor(this.app, note.file, color);
			};
		}

		let saveTimer: number | undefined;
		textarea.oninput = () => {
			if (saveTimer) window.clearTimeout(saveTimer);
			saveTimer = window.setTimeout(() => {
				void writeStickyBody(this.app, note.file, textarea.value);
			}, AUTOSAVE_DEBOUNCE_MS);
		};

		closeBtn.onclick = async () => {
			// 실제 윈도우 스티키노트도 삭제 전에 한 번 확인한다 — 메모 내용은 다른 데
			// 저장돼 있지 않을 수 있어 가볍게 보고 지우면 돌이킬 수 없다.
			if (!window.confirm("이 메모를 삭제할까요?")) return;
			if (saveTimer) window.clearTimeout(saveTimer);
			await deleteStickyNote(this.app, note.file);
			card.remove();
		};

		return card;
	}
}
