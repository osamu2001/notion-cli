import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../util/errors.js";
import { MCPConnection } from "./client.js";

describe("MCPConnection", () => {
	afterEach(() => {
		delete process.env.NCLI_DEBUG_MCP;
		delete process.env.NCLI_DEBUG_MCP_FILE;
		vi.restoreAllMocks();
	});

	it("throws CliError when calling callTool before connect", async () => {
		const conn = new MCPConnection();
		await expect(conn.callTool("notion-search", { query: "test" })).rejects.toThrow(CliError);
		await expect(conn.callTool("notion-search", { query: "test" })).rejects.toThrow(
			"Not connected",
		);
	});

	it("throws CliError when calling listTools before connect", async () => {
		const conn = new MCPConnection();
		await expect(conn.listTools()).rejects.toThrow(CliError);
		await expect(conn.listTools()).rejects.toThrow("Not connected");
	});

	it("disconnect is safe when not connected", async () => {
		const conn = new MCPConnection();
		await expect(conn.disconnect()).resolves.toBeUndefined();
	});

	it("emits MCP debug trace to stderr when NCLI_DEBUG_MCP is enabled", async () => {
		process.env.NCLI_DEBUG_MCP = "1";
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const conn = new MCPConnection() as MCPConnection & {
			client: {
				callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
			};
		};
		conn.client = {
			callTool: async () =>
				({
					content: [{ type: "text", text: "ok" }],
					isError: false,
				}) as Record<string, unknown>,
		};

		await expect(
			conn.callTool("notion-search", { query: "test", page_size: 25 }),
		).resolves.toMatchObject({
			isError: false,
		});

		expect(stderrWrite).toHaveBeenCalled();
		const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(written).toContain('"op":"call_tool"');
		expect(written).toContain('"phase":"start"');
		expect(written).toContain('"phase":"success"');
		expect(written).toContain('"tool":"notion-search"');
		expect(written).toContain('"query":"test"');
	});

	it("emits MCP error summaries when a tool returns isError", async () => {
		process.env.NCLI_DEBUG_MCP = "1";
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const conn = new MCPConnection() as MCPConnection & {
			client: {
				callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
			};
		};
		conn.client = {
			callTool: async () =>
				({
					content: [
						{
							type: "text",
							text: JSON.stringify({ message: "body failed validation" }),
						},
					],
					isError: true,
				}) as Record<string, unknown>,
		};

		await expect(conn.callTool("notion-fetch", { id: "page-1" })).rejects.toThrow(
			"notion-fetch failed",
		);

		const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(written).toContain('"phase":"error"');
		expect(written).toContain('"error_class":"mcp_result_error"');
		expect(written).toContain('"mcp_error_summary":"body failed validation"');
	});

	it("treats --verbose as an MCP debug trigger for listTools", async () => {
		const originalArgv = [...process.argv];
		process.argv = [...process.argv, "--verbose"];
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const conn = new MCPConnection() as MCPConnection & {
				client: { listTools: () => Promise<{ tools: [] }> };
			};
			conn.client = {
				listTools: async () => ({ tools: [] }),
			};

			await expect(conn.listTools()).resolves.toEqual([]);
		} finally {
			process.argv = originalArgv;
		}

		const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(written).toContain('"op":"list_tools"');
		expect(written).toContain('"phase":"success"');
	});
});
