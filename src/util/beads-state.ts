import fs from "node:fs";
import path from "node:path";
import { BEADS_STATE_PATH, CONFIG_DIR } from "./config.js";
import { CliError } from "./errors.js";

export interface StoredBeadsState {
	database_id: string;
	page_ids: Record<string, string>;
}

export interface StoredBeadsStateEntry {
	id: string;
	page_id: string;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortPageIds(pageIds: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(pageIds).sort(([left], [right]) => left.localeCompare(right)),
	);
}

export function listStoredBeadsStateEntries(state: StoredBeadsState): StoredBeadsStateEntry[] {
	return Object.entries(state.page_ids)
		.map(([id, page_id]) => ({ id, page_id }))
		.sort((left, right) => left.id.localeCompare(right.id));
}

export function normalizeStoredBeadsState(
	value: unknown,
	source: string = "beads state",
): StoredBeadsState {
	if (!isStringRecord(value)) {
		throw new CliError(
			"Invalid beads state",
			`${source} must be a JSON object`,
			'Use {"database_id":"<db-id>","page_ids":{"bd-1":"<page-id>"}}',
		);
	}

	const databaseId = typeof value.database_id === "string" ? value.database_id.trim() : "";
	if (!databaseId) {
		throw new CliError(
			"Invalid beads state",
			`${source} must include a non-empty "database_id"`,
			'Use {"database_id":"<db-id>","page_ids":{"bd-1":"<page-id>"}}',
		);
	}

	if (!isStringRecord(value.page_ids)) {
		throw new CliError(
			"Invalid beads state",
			`${source} must include a "page_ids" object`,
			'Use {"database_id":"<db-id>","page_ids":{"bd-1":"<page-id>"}}',
		);
	}

	const pageIds: Record<string, string> = {};
	const seenPageIds = new Set<string>();
	for (const [beadsId, pageIdValue] of Object.entries(value.page_ids)) {
		const normalizedBeadsId = beadsId.trim();
		if (!normalizedBeadsId) {
			throw new CliError(
				"Invalid beads state",
				`${source} contains an empty Beads ID key`,
				"Each saved mapping must use a non-empty Beads ID key",
			);
		}
		if (typeof pageIdValue !== "string" || !pageIdValue.trim()) {
			throw new CliError(
				"Invalid beads state",
				`${source} contains an empty page id for Beads ID ${normalizedBeadsId}`,
				"Each saved mapping must point to a non-empty Notion page id",
			);
		}
		const normalizedPageId = pageIdValue.trim();
		if (seenPageIds.has(normalizedPageId)) {
			throw new CliError(
				"Invalid beads state",
				`${source} contains duplicate page id ${normalizedPageId}`,
				"A Notion page id can only be mapped to one Beads ID",
			);
		}
		seenPageIds.add(normalizedPageId);
		pageIds[normalizedBeadsId] = normalizedPageId;
	}

	return {
		database_id: databaseId,
		page_ids: sortPageIds(pageIds),
	};
}

export function parseStoredBeadsState(value: unknown): StoredBeadsState | undefined {
	try {
		return normalizeStoredBeadsState(value);
	} catch {
		return undefined;
	}
}

export class BeadsStateStore {
	constructor(private configDir: string = CONFIG_DIR) {}

	filePath(): string {
		return this.configDir === CONFIG_DIR
			? BEADS_STATE_PATH
			: path.join(this.configDir, "beads-state.json");
	}

	private ensureDir(): void {
		fs.mkdirSync(this.configDir, { recursive: true });
	}

	read(): StoredBeadsState | undefined {
		try {
			const data = JSON.parse(fs.readFileSync(this.filePath(), "utf-8")) as unknown;
			return parseStoredBeadsState(data);
		} catch {
			return undefined;
		}
	}

	save(state: StoredBeadsState): void {
		this.ensureDir();
		const normalized = normalizeStoredBeadsState(state);
		fs.writeFileSync(this.filePath(), JSON.stringify(normalized, null, 2), { mode: 0o600 });
	}

	clear(): void {
		try {
			fs.unlinkSync(this.filePath());
		} catch {
			// no-op if file does not exist
		}
	}

	readForDatabase(databaseId: string): StoredBeadsState | undefined {
		const state = this.read();
		if (!state || state.database_id !== databaseId) {
			return undefined;
		}
		return state;
	}
}

export { BEADS_STATE_PATH };
