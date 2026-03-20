import fs from "node:fs";
import path from "node:path";
import { BEADS_CONFIG_PATH, CONFIG_DIR } from "./config.js";
import { CliError } from "./errors.js";

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

	private normalizeConfig(value: unknown): StoredBeadsConfig {
		if (
			typeof value === "object" &&
			value !== null &&
			typeof (value as StoredBeadsConfig).database_id === "string" &&
			typeof (value as StoredBeadsConfig).data_source_id === "string" &&
			typeof (value as StoredBeadsConfig).view_url === "string" &&
			typeof (value as StoredBeadsConfig).schema_version === "string"
		) {
			return value as StoredBeadsConfig;
		}
		throw new CliError(
			"Invalid beads config",
			`${this.filePath()} is missing one of: database_id, data_source_id, view_url, schema_version`,
			'Fix the JSON or regenerate it with "ncli beads config set --database-id <id> --view-url <url>"',
		);
	}

	read(): StoredBeadsConfig | undefined {
		try {
			const data = JSON.parse(fs.readFileSync(this.filePath(), "utf8")) as unknown;
			return this.normalizeConfig(data);
		} catch {
			return undefined;
		}
	}

	readStrict(): StoredBeadsConfig | undefined {
		let raw: string;
		try {
			raw = fs.readFileSync(this.filePath(), "utf8");
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				return undefined;
			}
			throw error;
		}
		let data: unknown;
		try {
			data = JSON.parse(raw) as unknown;
		} catch {
			throw new CliError(
				"Invalid beads config",
				`${this.filePath()} could not be parsed as JSON`,
				'Fix the JSON or remove it with "ncli beads config clear" before retrying',
			);
		}
		return this.normalizeConfig(data);
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
