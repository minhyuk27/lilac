import { Notice, Plugin, TFile, TAbstractFile } from "obsidian";
import { LilacDatabase } from "./src/database";
import { scanVault, parseLilacItem } from "./src/scanner";
import { loadCategories, CATEGORIES_PATH } from "./src/categories";
import { LilacCalendarView, VIEW_TYPE_CALENDAR } from "./src/calendar-view";

export default class LilacPlugin extends Plugin {
	private db: LilacDatabase | null = null;

	getDatabase(): LilacDatabase | null {
		return this.db;
	}

	async onload() {
		console.log("lilac: loading");

		await this.rebuildIndex();

		this.registerView(VIEW_TYPE_CALENDAR, (leaf) => new LilacCalendarView(leaf, this));

		// metadataCache "changed" fires after Obsidian has parsed frontmatter,
		// so it covers both new and edited notes without racing the parser.
		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.onFileChanged(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.onFileDeleted(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onFileRenamed(file, oldPath)));

		this.addRibbonIcon("calendar-days", "Lilac 캘린더 열기", () => void this.openCalendarView());

		this.addCommand({
			id: "lilac-open-calendar",
			name: "Open calendar view",
			callback: () => void this.openCalendarView(),
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

	private async openCalendarView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)[0];
		const leaf = existing ?? this.app.workspace.getLeaf("tab");
		if (!existing) await leaf.setViewState({ type: VIEW_TYPE_CALENDAR, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	private refreshCalendarViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
			if (leaf.view instanceof LilacCalendarView) leaf.view.refresh();
		}
	}

	private async rebuildIndex() {
		const wasmPath = `${this.manifest.dir}/sql-wasm.wasm`;
		const wasmBinary = await this.app.vault.adapter.readBinary(wasmPath);

		this.db?.close();
		this.db = await LilacDatabase.create(wasmBinary);
		this.db.setCategories(loadCategories(this.app));
		this.db.rebuildItems(scanVault(this.app));

		console.log(`lilac: indexed ${this.db.countItems()} items, ${this.db.countCategories()} categories`);
		this.refreshCalendarViews();
	}

	private onFileChanged(file: TFile) {
		if (!this.db || file.extension !== "md") return;

		if (file.path === CATEGORIES_PATH) {
			this.db.setCategories(loadCategories(this.app));
			this.refreshCalendarViews();
			return;
		}

		const item = parseLilacItem(this.app, file);
		if (item) {
			this.db.upsertItem(item);
		} else {
			// Covers the "lilac: true removed" case — harmless no-op otherwise.
			this.db.deleteItem(file.path);
		}
		this.refreshCalendarViews();
	}

	private onFileDeleted(file: TAbstractFile) {
		if (!this.db || !(file instanceof TFile)) return;

		if (file.path === CATEGORIES_PATH) {
			this.db.setCategories([]);
		} else {
			this.db.deleteItem(file.path);
		}
		this.refreshCalendarViews();
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
