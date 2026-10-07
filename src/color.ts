/** Color helpers for category-colored chips/bands — picks readable text color per background. */

/**
 * Shared "chip palette" mix ratios — how far a category color is lightened for a chip's
 * background / darkened for its text. Used by both the calendar view's event chips/bands
 * and the item modal's category picker so a category reads as the exact same color in
 * both places (사용자 요청, 2026-08-15: "다른 어플처럼... 이쁘게" — visual consistency
 * across the plugin's own screens is part of that).
 */
export const CHIP_BG_LIGHTEN = 0.5;
export const CHIP_TEXT_DARKEN = 0.35;

/** "#rgb"/"#rrggbb" -> [r,g,b] (0-255). Falls back to mid-gray for anything else (CSS var, bad input). */
export function parseHexRgb(hex: string): [number, number, number] | null {
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return null;
	const h = m[1];
	if (h.length === 3) {
		return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
	}
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG relative luminance (0=black, 1=white). */
function relativeLuminance(r: number, g: number, b: number): number {
	const [rs, gs, bs] = [r, g, b].map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Returns a CSS color value (dark text on light backgrounds, light text on dark ones).
 * Samsung 캘린더 샘플의 파스텔 칩 배경은 흰 텍스트보다 진한 텍스트일 때 명암비가 더 좋음
 * — 카테고리 색이 사용자마다 다르므로(Categories.md) 고정 흰색 대신 매번 계산.
 */
export function chipTextColor(hex: string | null | undefined): string {
	if (!hex) return "var(--text-on-accent)";
	const rgb = parseHexRgb(hex);
	if (!rgb) return "var(--text-on-accent)";
	const luminance = relativeLuminance(...rgb);
	return luminance > 0.6 ? "rgba(0, 0, 0, 0.78)" : "var(--text-on-accent)";
}

/**
 * Mixes `hex` toward white by `amount` (0-1) — used for the todo badge's glossy "petal"
 * gradient, and (2026-06-22, "삼성캘린더와 최대한 똑같이") for the pastel chip/band
 * backgrounds that replaced the old solid-color-on-white-text look. Returns hex (not
 * `rgb(...)`) specifically so the result can be fed straight back into `chipTextColor`,
 * which only parses hex.
 */
export function lighten(hex: string, amount: number): string {
	const rgb = parseHexRgb(hex);
	if (!rgb) return hex;
	const [r, g, b] = rgb.map((c) => Math.round(c + (255 - c) * amount));
	return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Mixes `hex` toward black by `amount` (0-1) — used for calendar chip/band text so the
 * label reads as a *darker shade of the category's own color* (Samsung 캘린더 샘플처럼
 * 진한 남색 텍스트가 옅은 하늘색 칩 위에 — 검정/흰색 둘 중 하나로만 고정하는 것보다
 * 칩마다 카테고리 색이 더 또렷이 느껴짐), instead of a generic black/white pick.
 */
export function darken(hex: string, amount: number): string {
	const rgb = parseHexRgb(hex);
	if (!rgb) return hex;
	const [r, g, b] = rgb.map((c) => Math.round(c * (1 - amount)));
	return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * True when Obsidian's active theme is dark (`.theme-dark` on `<body>`, same class the app
 * itself toggles when the user switches Appearance → Base color scheme, or the OS theme in
 * "Adapt to system" mode).
 */
export function isDarkTheme(): boolean {
	return document.body.classList.contains("theme-dark");
}

/**
 * Day-cell tint that adapts to the active theme instead of always lightening toward white.
 * `lighten(hex, lightenAmount)` (light theme's original formula, ~0.88) mixes almost all the
 * way to white — fine on a light canvas, but in dark mode it painted every tinted cell
 * near-white while `.lilac-cell-date`'s text stayed `--text-normal` (light-colored in dark
 * theme), so the day number all but disappeared (사용자 요청, 2026-08-18: "다크모드
 * 만들어줘" — 캘린더 칸이 흰 배경에 흰 글자로 안 보이던 문제). Dark theme darkens toward
 * black instead — but at a *lower* amount than the light-theme lighten ratio: `darken()`
 * scales every channel by `(1-amount)`, so reusing the same ~0.88 crushes a category color's
 * saturation/lightness almost to black at high amounts (perceptually harsher than the
 * equivalent lighten, since lightening a color toward white keeps it reading as a bright
 * pastel while darkening the same amount toward black loses the hue entirely) — categories
 * that were already darker/duller nearly vanished into the app's own dark background
 * (사용자 보고, 2026-08-18: 다크모드 칸 시인성). `darkenAmount` defaults lower than
 * `lightenAmount` for that reason. Pair with `chipTextColor()` on the result to pick the
 * day-number color.
 */
export function cellTint(hex: string, lightenAmount: number, darkenAmount = 0.55): string {
	return isDarkTheme() ? darken(hex, darkenAmount) : lighten(hex, lightenAmount);
}
