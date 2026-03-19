import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config.js";

export interface StoredBeadsState {
	database_id: string;
	page_ids: Record<string, string>;
}

export class BeadsStateStore {
	constructor(private configDir: string = CONFIG_DIR) {}

	filePath(): string {
		return path.join(this.configDir, "beads-state.json");
	}

	read(): StoredBeadsState | undefined {
		try {
			const data = fs.readFileSync(this.filePath(), "utf-8");
			return JSON.parse(data) as StoredBeadsState;
		} catch {
			return undefined;
		}
	}

	save(state: StoredBeadsState): void {
		fs.mkdirSync(this.configDir, { recursive: true });
		fs.writeFileSync(this.filePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
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
