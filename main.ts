import { Notice, Plugin, TFile, TAbstractFile } from "obsidian";
import { getDateFromFile } from "obsidian-daily-notes-interface";
import { LilacDatabase } from "./src/database";
import { scanVault, parseLilacItem } from "./src/scanner";
import { loadCategories, CATEGORIES_PATH } from "./src/categories";
import { LilacCalendarView, VIEW_TYPE_CALENDAR } from "./src/calendar-view";
import { LilacStickyModal } from "./src/sticky-modal";
import { renderDailyBlock } from "./src/daily-render";
import { openDailyNote } from "./src/daily-note";
import { toISO } from "./src/dates";
import { LilacSettingTab } from "./src/settings-tab";
import { LilacSettings, DEFAULT_SETTINGS } from "./src/settings";

export default class LilacPlugin extends Plugin {
	private db: LilacDatabase | null = null;
	settings: LilacSettings = DEFAULT_SETTINGS;

	getDatabase(): LilacDatabase | null {
		return this.db;
	}

	async onload() {
		console.log("lilac: loading");

		await this.loadSettings();
		await this.rebuildIndex();

		// 안드로이드 등 모바일 콜드 스타트에서는 플러그인이 로드되는 시점에 metadataCache가
		// 아직 볼트 전체의 초기 해석을 못 끝낸 경우가 있다(특히 노트 수가 많을 때 — 데스크톱
		// 보다 파일 I/O가 느려 흔함). 그 상태에서 위 rebuildIndex()가 돌면 scanVault()가
		// metadataCache.getFileCache()로 frontmatter를 읽는데, 아직 해석 안 된 파일은 캐시가
		// 비어 있어 `lilac: true`를 못 찾고 통째로 빠진다 — 이후 그 파일이 직접 수정되기
		// 전까진 "changed" 이벤트도 안 와서 누락이 그대로 남는다("접속할 때마다 rebuild
		// index 해야 표시" 보고, 2026-06-22). metadataCache가 초기 해석을 다 끝내면 한 번
		// 쏘는 전역 "resolved" 이벤트를 받아 그때 캐치업으로 한 번 더 인덱싱한다 — 이미
		// 해석이 끝난 뒤(데스크톱 등)라면 "resolved"가 이 리스너 등록 전에 이미 지나갔을
		// 수도 있지만, 그 경우 위의 즉시 rebuildIndex()가 이미 완전한 캐시로 돌았으므로
		// 문제 없다.
		const onMetadataResolved = () => {
			this.app.metadataCache.off("resolved", onMetadataResolved);
			void this.rebuildIndex();
		};
		this.registerEvent(this.app.metadataCache.on("resolved", onMetadataResolved));

		this.registerView(VIEW_TYPE_CALENDAR, (leaf) => new LilacCalendarView(leaf, this));
		this.addSettingTab(new LilacSettingTab(this.app, this));

		// SPEC §3.2: 데일리노트 템플릿에 한 줄 삽입해두면 그날의 일정·할일을 인터랙티브하게
		// 렌더. 날짜는 코드블록 자신이 아니라 파일 경로(데일리노트 파일명)에서 역산한다.
		this.registerMarkdownCodeBlockProcessor("lilac-daily", async (_source, el, ctx) => {
			const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
			const date = file instanceof TFile ? getDateFromFile(file, "day") : null;
			if (date) {
				await renderDailyBlock(this.app, this, toISO(date.toDate()), el);
			} else {
				// 파일명이 데일리노트 날짜 형식이 아니면(다른 노트에 블록을 복사해 넣은 경우 등)
				// 조용히 빈 화면을 보여주는 대신 원인을 알려준다.
				el.createDiv({
					cls: "lilac-day-detail-empty",
					text: "이 노트는 데일리노트 날짜 형식으로 인식되지 않아 lilac-daily를 표시할 수 없습니다.",
				});
			}
		});

		// metadataCache "changed" fires after Obsidian has parsed frontmatter,
		// so it covers both new and edited notes without racing the parser.
		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.onFileChanged(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.onFileDeleted(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onFileRenamed(file, oldPath)));
		// 안전망: 캘린더 탭이 백그라운드에 있는 동안 바뀐 내용을 놓쳤을 가능성에 대비해
		// 그 탭이 다시 활성화되는 순간 무조건 한 번 더 그린다(2026-06-21, "rebuild
		// index 안 해도 자동으로 갱신" 요청).
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof LilacCalendarView) leaf.view.refresh();
			})
		);

		this.addRibbonIcon("calendar-days", "Lilac 캘린더 열기", () => void this.openCalendarView());
		this.addRibbonIcon("sticky-note", "Lilac 스티키노트 열기", () => new LilacStickyModal(this.app, this).open());
		this.addRibbonIcon("calendar-check", "오늘 노트 열기", () => void openDailyNote(this.app, new Date()));

		this.addCommand({
			id: "lilac-open-calendar",
			name: "Open calendar view",
			callback: () => void this.openCalendarView(),
		});

		this.addCommand({
			id: "lilac-open-sticky",
			name: "Open sticky notes",
			callback: () => new LilacStickyModal(this.app, this).open(),
		});

		this.addCommand({
			id: "lilac-open-today",
			name: "Open today's daily note",
			callback: () => void openDailyNote(this.app, new Date()),
		});

		this.addCommand({
			id: "lilac-rebuild-index",
			name: "Rebuild index (rescan vault)",
			callback: async () => {
				await this.rebuildIndex();
				this.reportStats("index rebuilt");
			},
		});

		this.addCommand({
			id: "lilac-show-index-stats",
			name: "Show index stats",
			callback: () => this.reportStats("index"),
		});
	}

	onunload() {
		console.log("lilac: unloading");
		this.db?.close();
		this.db = null;
	}

	async openCalendarView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)[0];
		const leaf = existing ?? this.app.workspace.getLeaf("tab");
		if (!existing) await leaf.setViewState({ type: VIEW_TYPE_CALENDAR, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	refreshViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
			if (leaf.view instanceof LilacCalendarView) leaf.view.refresh();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async rebuildIndex() {
		const wasmPath = `${this.manifest.dir}/sql-wasm.wasm`;
		const wasmBinary = await this.app.vault.adapter.readBinary(wasmPath);

		this.db?.close();
		this.db = await LilacDatabase.create(wasmBinary);
		this.db.setCategories(loadCategories(this.app));
		this.db.rebuildItems(scanVault(this.app));

		console.log(`lilac: indexed ${this.db.countItems()} items, ${this.db.countCategories()} categories`);
		this.refreshViews();
	}

	private onFileChanged(file: TFile) {
		if (!this.db || file.extension !== "md") return;

		if (file.path === CATEGORIES_PATH) {
			this.db.setCategories(loadCategories(this.app));
			this.refreshViews();
			return;
		}

		const item = parseLilacItem(this.app, file);
		if (item) {
			this.db.upsertItem(item);
		} else {
			// Covers the "lilac: true removed" case — harmless no-op otherwise.
			this.db.deleteItem(file.path);
		}
		this.refreshViews();
	}

	private onFileDeleted(file: TAbstractFile) {
		if (!this.db || !(file instanceof TFile)) return;

		if (file.path === CATEGORIES_PATH) {
			this.db.setCategories([]);
		} else {
			this.db.deleteItem(file.path);
		}
		this.refreshViews();
	}

	private onFileRenamed(file: TAbstractFile, oldPath: string) {
		if (!this.db || !(file instanceof TFile)) return;

		this.db.deleteItem(oldPath);
		this.onFileChanged(file);
	}

	private reportStats(label: string) {
		new Notice(`lilac: ${label} — ${this.db?.countItems() ?? 0} items, ${this.db?.countCategories() ?? 0} categories`);
	}
}
