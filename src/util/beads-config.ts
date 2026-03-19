import fs from "node:fs";
import path from "node:path";
import { BEADS_CONFIG_PATH, CONFIG_DIR } from "./config.js";

export interface StoredBeadsConfig {
	database_id: string;
	data_source_id: string;
	view_url: string;
	schema_version: string;
}

export class BeadsConfigStore {
	constructor(private configDir: string = CONFIG_DIR) {}

	filePath(): string {
		return path.join(this.configDir, "beads.json");
	}

	private ensureDir(): void {
		fs.mkdirSync(this.configDir, { recursive: true });
	}

	read(): StoredBeadsConfig | undefined {
		try {
			const data = JSON.parse(fs.readFileSync(this.filePath(), "utf8")) as unknown;
			if (
				typeof data === "object" &&
				data !== null &&
				typeof (data as StoredBeadsConfig).database_id === "string" &&
				typeof (data as StoredBeadsConfig).data_source_id === "string" &&
				typeof (data as StoredBeadsConfig).view_url === "string" &&
				typeof (data as StoredBeadsConfig).schema_version === "string"
			) {
				return data as StoredBeadsConfig;
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	save(config: StoredBeadsConfig): void {
		this.ensureDir();
		fs.writeFileSync(this.filePath(), JSON.stringify(config, null, 2), { mode: 0o600 });
	}

	clear(): void {
		try {
			fs.unlinkSync(this.filePath());
		} catch {
			// no-op if file does not exist
		}
	}
}

export { BEADS_CONFIG_PATH };
