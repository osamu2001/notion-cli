import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BeadsConfigStore } from "./beads-config.js";

describe("BeadsConfigStore", () => {
	let tmpDir: string;
	let store: BeadsConfigStore;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ncli-beads-config-"));
		store = new BeadsConfigStore(tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns undefined when no config exists", () => {
		expect(store.read()).toBeUndefined();
	});

	it("saves and reads config", () => {
		const config = {
			database_id: "db-1",
			data_source_id: "ds-1",
			view_url: "view://one",
			schema_version: "beads/v1",
		};
		store.save(config);
		expect(store.read()).toEqual(config);
	});

	it("clears config", () => {
		store.save({
			database_id: "db-1",
			data_source_id: "ds-1",
			view_url: "view://one",
			schema_version: "beads/v1",
		});
		store.clear();
		expect(store.read()).toBeUndefined();
	});

	it("creates nested directories when saving", () => {
		const nested = path.join(tmpDir, "a", "b", "c");
		const nestedStore = new BeadsConfigStore(nested);
		nestedStore.save({
			database_id: "db-1",
			data_source_id: "ds-1",
			view_url: "view://one",
			schema_version: "beads/v1",
		});
		expect(nestedStore.read()?.view_url).toBe("view://one");
	});

	it("writes config with 0o600 permissions", () => {
		store.save({
			database_id: "db-1",
			data_source_id: "ds-1",
			view_url: "view://one",
			schema_version: "beads/v1",
		});
		const stat = fs.statSync(path.join(tmpDir, "beads.json"));
		expect(stat.mode & 0o777).toBe(0o600);
	});
});
