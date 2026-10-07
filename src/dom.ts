/**
 * Lets a plain desktop mouse wheel (vertical-only — no horizontal axis, unlike a touch
 * swipe or trackpad) drive one of the plugin's horizontal-scroll chip trays
 * (`.lilac-modal-category-row`, `.lilac-time-picker-row`).
 * Without this, a PC user with a normal mouse had no way to reach chips past the first
 * screenful — touch swipe and trackpad two-finger/shift-scroll already worked, but a
 * vertical wheel gesture just did nothing since the tray has no vertical overflow
 * (사용자 보고, 2026-08-18: "카테고리부분 좌우스와이프 불가능 (pc 기준)"). Only
 * remaps when there's actually more to scroll, and leaves a gesture that already carries
 * its own horizontal component (trackpad/shift-wheel) untouched.
 */
export function enableWheelHorizontalScroll(el: HTMLElement): void {
	el.addEventListener(
		"wheel",
		(e: WheelEvent) => {
			if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
			if (el.scrollWidth <= el.clientWidth) return;
			el.scrollLeft += e.deltaY;
			e.preventDefault();
		},
		{ passive: false },
	);
}
