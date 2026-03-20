import { appendFileSync } from "node:fs";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CallbackServer } from "../auth/callback-server.js";
import { NotionOAuthProvider } from "../auth/provider.js";
import { TokenStore } from "../auth/token-store.js";
import { CONFIG_DIR, MCP_SERVER_URL } from "../util/config.js";
import { CliError } from "../util/errors.js";

interface McpDebugEvent {
	timestamp: string;
	op: "connect" | "call_tool" | "list_tools";
	phase: "start" | "success" | "error" | "auth_retry";
	tool?: string;
	args_summary?: Record<string, unknown>;
	duration_ms?: number;
	error_class?: string;
	error_message?: string;
	mcp_is_error?: boolean;
	mcp_error_summary?: string;
	server_url?: string;
}

class McpDebugLogger {
	private readonly stderrEnabled: boolean;
	private readonly filePath: string | null;

	constructor(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env) {
		const envEnabled = /^1|true|yes$/i.test((env.NCLI_DEBUG_MCP ?? "").trim());
		this.stderrEnabled = envEnabled || argv.includes("--verbose");
		this.filePath = (env.NCLI_DEBUG_MCP_FILE ?? "").trim() || null;
	}

	log(event: Omit<McpDebugEvent, "timestamp">): void {
		if (!this.stderrEnabled && !this.filePath) {
			return;
		}
		const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
		if (this.stderrEnabled) {
			process.stderr.write(`[ncli:mcp] ${line}\n`);
		}
		if (this.filePath) {
			try {
				appendFileSync(this.filePath, `${line}\n`, "utf8");
			} catch (error) {
				if (this.stderrEnabled) {
					process.stderr.write(
						`[ncli:mcp] ${JSON.stringify({
							timestamp: new Date().toISOString(),
							op: event.op,
							phase: "error",
							error_class: error instanceof Error ? error.name : typeof error,
							error_message:
								error instanceof Error
									? `failed to append debug log to ${this.filePath}: ${error.message}`
									: `failed to append debug log to ${this.filePath}: ${String(error)}`,
						})}\n`,
					);
				}
			}
		}
	}
}

function summarizeMcpDebugValue(value: unknown, depth = 0): unknown {
	if (value == null || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
	}
	if (Array.isArray(value)) {
		if (depth >= 2) {
			return `[array:${value.length}]`;
		}
		return value.slice(0, 5).map((item) => summarizeMcpDebugValue(item, depth + 1));
	}
	if (typeof value === "object") {
		if (depth >= 2) {
			return "[object]";
		}
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.slice(0, 10)
				.map(([key, entryValue]) => [key, summarizeMcpDebugValue(entryValue, depth + 1)]),
		);
	}
	return String(value);
}

function summarizeMcpDebugArgs(args: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(args)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, value]) => [key, summarizeMcpDebugValue(value)]),
	);
}

export class MCPConnection {
	private client: Client | null = null;
	private callbackServer: CallbackServer | null = null;
	private readonly debug = new McpDebugLogger();

	async connect(): Promise<void> {
		const tokenStore = new TokenStore(CONFIG_DIR);
		const callbackServer = new CallbackServer();
		this.callbackServer = callbackServer;

		// Start the callback server first to get the port
		const callbackPromise = callbackServer.waitForCallback();

		const provider = new NotionOAuthProvider(tokenStore, callbackServer);
		const serverUrl = new URL(MCP_SERVER_URL);

		const client = new Client({ name: "ncli", version: "0.2.0" }, { capabilities: {} });
		this.client = client;

		let transport = new StreamableHTTPClientTransport(serverUrl, {
			authProvider: provider,
		});
		const startedAt = Date.now();
		this.debug.log({
			op: "connect",
			phase: "start",
			server_url: serverUrl.toString(),
		});

		try {
			await client.connect(transport);
			this.debug.log({
				op: "connect",
				phase: "success",
				server_url: serverUrl.toString(),
				duration_ms: Date.now() - startedAt,
			});
		} catch (error) {
			if (error instanceof UnauthorizedError) {
				console.error("Opening browser for Notion login...");
				this.debug.log({
					op: "connect",
					phase: "auth_retry",
					server_url: serverUrl.toString(),
					duration_ms: Date.now() - startedAt,
					error_class: error.name,
					error_message: error.message,
				});

				const code = await callbackPromise;
				await transport.finishAuth(code);

				// Reconnect with new tokens
				transport = new StreamableHTTPClientTransport(serverUrl, {
					authProvider: provider,
				});
				await client.connect(transport);
				this.debug.log({
					op: "connect",
					phase: "success",
					server_url: serverUrl.toString(),
					duration_ms: Date.now() - startedAt,
				});
			} else {
				callbackServer.stop();
				this.debug.log({
					op: "connect",
					phase: "error",
					server_url: serverUrl.toString(),
					duration_ms: Date.now() - startedAt,
					error_class: error instanceof Error ? error.name : typeof error,
					error_message: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		}
	}

	async callTool(
		name: string,
		args: Record<string, unknown> = {},
	): Promise<Awaited<ReturnType<Client["callTool"]>>> {
		if (!this.client) {
			throw new CliError(
				"Not connected to Notion",
				"connect() has not been called",
				"Run any command — connection is automatic",
			);
		}
		const startedAt = Date.now();
		const argsSummary = summarizeMcpDebugArgs(args);
		this.debug.log({
			op: "call_tool",
			phase: "start",
			tool: name,
			args_summary: argsSummary,
		});
		let errorLogged = false;
		try {
			const result = await this.client.callTool({ name, arguments: args });
			if (result.isError) {
				errorLogged = true;
				this.debug.log({
					op: "call_tool",
					phase: "error",
					tool: name,
					args_summary: argsSummary,
					duration_ms: Date.now() - startedAt,
					error_class: "mcp_result_error",
					mcp_is_error: true,
					mcp_error_summary: extractMcpErrorMessage(result),
				});
				throw mcpErrorToCliError(name, result);
			}
			this.debug.log({
				op: "call_tool",
				phase: "success",
				tool: name,
				args_summary: argsSummary,
				duration_ms: Date.now() - startedAt,
				mcp_is_error: false,
			});
			return result;
		} catch (error) {
			if (!errorLogged) {
				this.debug.log({
					op: "call_tool",
					phase: "error",
					tool: name,
					args_summary: argsSummary,
					duration_ms: Date.now() - startedAt,
					error_class: error instanceof Error ? error.name : typeof error,
					error_message: error instanceof Error ? error.message : String(error),
				});
			}
			throw error;
		}
	}

	async listTools(): Promise<Tool[]> {
		if (!this.client) {
			throw new CliError(
				"Not connected to Notion",
				"connect() has not been called",
				"Run any command — connection is automatic",
			);
		}
		const startedAt = Date.now();
		this.debug.log({ op: "list_tools", phase: "start" });
		try {
			const result = await this.client.listTools();
			this.debug.log({
				op: "list_tools",
				phase: "success",
				duration_ms: Date.now() - startedAt,
			});
			return result.tools;
		} catch (error) {
			this.debug.log({
				op: "list_tools",
				phase: "error",
				duration_ms: Date.now() - startedAt,
				error_class: error instanceof Error ? error.name : typeof error,
				error_message: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async disconnect(): Promise<void> {
		if (this.client) {
			await this.client.close();
			this.client = null;
		}
		if (this.callbackServer) {
			this.callbackServer.stop();
			this.callbackServer = null;
		}
	}
}

function extractMcpErrorMessage(result: Record<string, unknown>): string {
	const content = result.content;
	if (!Array.isArray(content)) return "Unknown MCP error";
	const text = (content as Array<{ type: string; text?: string }>)
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text)
		.join("\n");
	try {
		const parsed = JSON.parse(text);
		if (parsed.body) {
			try {
				const body = JSON.parse(parsed.body);
				return body.message || parsed.message || text;
			} catch {
				return parsed.message || text;
			}
		}
		return parsed.message || text;
	} catch {
		return text || "Unknown MCP error";
	}
}

interface HintRule {
	pattern: RegExp;
	tool?: string;
	hint: string;
}

const HINT_RULES: HintRule[] = [
	// Tool-specific hints (checked first)
	{
		pattern: /could not find page with id/i,
		tool: "notion-create-pages",
		hint: 'If adding to a database, use --parent collection://<ds-id>. For --data, use "parent":{"data_source_id":"<uuid>","type":"data_source_id"}. Run "ncli fetch <db-id>" to get the data_source_id',
	},
	{
		pattern: /invalid database view url/i,
		hint: 'Use a view URL with ?v= parameter. Run "ncli fetch <db-id>" to find view URLs, or create one with "ncli view create"',
	},
	{
		pattern: /data_source_id[\s\S]*?required/i,
		hint: "data_source_id is required. Use --parent collection://<ds-id> or, with --data, pass the bare UUID from the fetched collection://... value",
	},
	{
		pattern: /rich_text[\s\S]*?required/i,
		hint: 'Use --body "your comment text" to set the comment content',
	},
	{
		pattern: /tool .* not found/i,
		hint: 'Run "ncli --help" to see available commands, or check the tool name for typos',
	},
	// Generic hints
	{
		pattern: /unauthorized|not authorized/i,
		hint: 'Run "ncli login" to re-authenticate',
	},
	{
		pattern: /could not find|does not exist/i,
		hint: 'Check the ID or URL. Run "ncli search" to find the correct resource',
	},
	{
		pattern: /rate limit|429/i,
		hint: "Wait a moment and retry. The CLI retries automatically up to 3 times",
	},
	{
		pattern: /input validation error/i,
		hint: 'Check required arguments. Use --data for full control, or run "ncli <command> --help" for usage',
	},
];

function mcpErrorToCliError(toolName: string, result: Record<string, unknown>): CliError {
	const message = extractMcpErrorMessage(result);
	const rule = HINT_RULES.find((r) => r.pattern.test(message) && (!r.tool || r.tool === toolName));
	return new CliError(`${toolName} failed`, message, rule?.hint);
}
