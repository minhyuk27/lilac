import { Notice, Plugin, TFile, TAbstractFile } from "obsidian";
import { LilacDatabase } from "./src/database";
import { scanVault, parseLilacItem } from "./src/scanner";
import { loadCategories, CATEGORIES_PATH } from "./src/categories";

export default class LilacPlugin extends Plugin {
	private db: LilacDatabase | null = null;

	async onload() {
		console.log("lilac: loading");

		await this.rebuildIndex();

		// metadataCache "changed" fires after Obsidian has parsed frontmatter,
		// so it covers both new and edited notes without racing the parser.
		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.onFileChanged(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.onFileDeleted(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onFileRenamed(file, oldPath)));

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

	private async rebuildIndex() {
		const wasmPath = `${this.manifest.dir}/sql-wasm.wasm`;
		const wasmBinary = await this.app.vault.adapter.readBinary(wasmPath);

		this.db?.close();
		this.db = await LilacDatabase.create(wasmBinary);
		this.db.setCategories(loadCategories(this.app));
		this.db.rebuildItems(scanVault(this.app));

		console.log(`lilac: indexed ${this.db.countItems()} items, ${this.db.countCategories()} categories`);
	}

	private onFileChanged(file: TFile) {
		if (!this.db || file.extension !== "md") return;

		if (file.path === CATEGORIES_PATH) {
			this.db.setCategories(loadCategories(this.app));
			return;
		}

		const item = parseLilacItem(this.app, file);
		if (item) {
			this.db.upsertItem(item);
		} else {
			// Covers the "lilac: true removed" case — harmless no-op otherwise.
			this.db.deleteItem(file.path);
		}
	}

	private onFileDeleted(file: TAbstractFile) {
		if (!this.db || !(file instanceof TFile)) return;

		if (file.path === CATEGORIES_PATH) {
			this.db.setCategories([]);
			return;
		}
		this.db.deleteItem(file.path);
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
