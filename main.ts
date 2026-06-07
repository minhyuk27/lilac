import { Notice, Plugin } from "obsidian";
import initSqlJs from "sql.js";

/**
 * Phase 0 skeleton.
 * Goal is NOT features — it's proving two things end-to-end:
 *   1. sql-wasm.wasm loads via adapter.readBinary on mobile (no URL fetch, no COOP/COEP needs)
 *   2. the repo -> vault plugin folder deploy pipeline + Syncthing propagation works
 */
export default class LilacPlugin extends Plugin {
	async onload() {
		console.log("lilac: loading");

		this.addRibbonIcon("calendar-days", "Lilac: test sql.js load", async () => {
			await this.testSqlJsLoad();
		});

		this.addCommand({
			id: "lilac-test-sqljs-load",
			name: "Test sql.js (WASM) load",
			callback: async () => {
				await this.testSqlJsLoad();
			},
		});
	}

	onunload() {
		console.log("lilac: unloading");
	}

	private async testSqlJsLoad() {
		try {
			const wasmPath = `${this.manifest.dir}/sql-wasm.wasm`;
			const wasmBinary = await this.app.vault.adapter.readBinary(wasmPath);
			const SQL = await initSqlJs({ wasmBinary });
			const db = new SQL.Database();
			db.run("CREATE TABLE items (path TEXT PRIMARY KEY, title TEXT);");
			db.run("INSERT INTO items VALUES (?, ?);", ["test.md", "hello lilac"]);
			const result = db.exec("SELECT * FROM items;");
			db.close();

			const row = result[0]?.values?.[0];
			new Notice(`lilac: sql.js OK — row = ${JSON.stringify(row)}`);
			console.log("lilac: sql.js init OK", result);
		} catch (err) {
			new Notice(`lilac: sql.js load FAILED — ${err}`);
			console.error("lilac: sql.js init failed", err);
		}
	}
}
