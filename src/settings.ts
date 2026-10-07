/**
 * 캘린더 레이아웃 밀도 — "auto"는 캘린더 패널의 실제 폭으로 판단(기존 동작 그대로).
 * mobile/tablet/desktop은 폭과 무관하게 그 레이아웃을 강제 — 사용자 요청, 2026-08-15:
 * "지금은 자동으로 모바일,pc 결정하게 되어있는데 태블릿이나 상황에 따라 내가 직접
 * 설정 가능하게". 옵시디언 앱 자체가 모바일 클라이언트인지(Platform.isMobile, 몰입형
 * 헤더 여부를 가르는 축)와는 별개 — 예를 들어 데스크톱 앱 창을 좁혀 쓰면서도 "desktop"
 * 밀도를 강제로 유지하거나, 반대로 태블릿에서 "mobile" 밀도를 쓰는 것도 가능하다.
 */
export type LilacDeviceMode = "auto" | "mobile" | "tablet" | "desktop";

/** Plugin-level settings (persisted via Obsidian's data.json — separate from Categories.md). */
export interface LilacSettings {
	/**
	 * PC(desktop 밀도)에서 캘린더 글자 크기를 얼마나 더 키울지, 퍼센트(100=기본).
	 * 자동 브레이크포인트 대신 사용자가 직접 조절 — 사용자 요청, 2026-06-22:
	 * "pc에서 글자크기 그냥 설정창에서 수동으로 조절할 수 있게". 모바일/태블릿 밀도에는
	 * 영향 없음(styles.css의 `.lilac-calendar[data-device="desktop"]` 안에서만 적용).
	 */
	calendarPcFontScale: number;
	/** 기본은 자동 판단 — 태블릿/특정 화면에서만 사용자가 직접 강제. */
	deviceMode: LilacDeviceMode;
}

export const DEFAULT_SETTINGS: LilacSettings = {
	calendarPcFontScale: 100,
	deviceMode: "auto",
};
