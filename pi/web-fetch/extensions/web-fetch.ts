/**
 * web-fetch — fetch a URL and return clean Markdown.
 *
 * Two tiers:
 *   1. static  — plain HTTP fetch (fast, free). Works for ordinary pages,
 *                PDFs, docx, and anything else markitdown can convert.
 *   2. browser — ghost-browser (stealth Chromium on Apify, raw CDP) renders
 *                the page, then the DOM HTML is converted. Used when
 *                render=true, or automatically when the static tier is
 *                blocked (403/407/429/5xx) or returns near-empty content.
 *
 * Conversion is done by `markitdown` (microsoft/markitdown), which must be on
 * PATH, as must `ghost-browser` for the browser tier (APIFY_TOKEN required).
 *
 * The ghost-browser session is left alive after a fetch (its daemon releases
 * it after ~10 idle minutes); repeated fetches reuse the same browser.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36";

function run(
	cmd: string,
	args: string[],
	options: { input?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const child = execFile(
			cmd,
			args,
			{ timeout: options.timeoutMs ?? 180_000, maxBuffer: 32 * 1024 * 1024, signal: options.signal },
			(error, stdout, stderr) => {
				const code = error ? ((error as NodeJS.ErrnoException & { code?: number | string }).code as number) ?? 1 : 0;
				resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: typeof code === "number" ? code : 1 });
			},
		);
		if (options.input !== undefined) {
			child.stdin?.write(options.input);
			child.stdin?.end();
		}
	});
}

/** Convert a file to Markdown with markitdown. */
async function toMarkdown(path: string, signal?: AbortSignal): Promise<string> {
	const result = await run("markitdown", [path], { signal });
	if (result.code !== 0) {
		throw new Error(`markitdown failed: ${result.stderr.slice(0, 300)}`);
	}
	return result.stdout;
}

function extensionForContentType(contentType: string, url: string): string {
	const ct = contentType.toLowerCase();
	if (ct.includes("pdf")) return ".pdf";
	if (ct.includes("html")) return ".html";
	if (ct.includes("json")) return ".json";
	if (ct.includes("csv")) return ".csv";
	if (ct.includes("xml")) return ".xml";
	if (ct.includes("plain")) return ".txt";
	if (ct.includes("wordprocessingml")) return ".docx";
	if (ct.includes("spreadsheetml")) return ".xlsx";
	if (ct.includes("presentationml")) return ".pptx";
	const fromUrl = extname(new URL(url).pathname);
	return fromUrl || ".html";
}

/** Tier 1: plain HTTP fetch. Returns markdown, or null when a browser retry makes sense. */
async function staticFetch(
	url: string,
	signal: AbortSignal | undefined,
	workDir: string,
): Promise<{ markdown: string } | { retry: string }> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
			redirect: "follow",
			signal,
		});
	} catch (error) {
		return { retry: `fetch error: ${error instanceof Error ? error.message : String(error)}` };
	}
	if ([401, 403, 407, 429, 500, 502, 503].includes(response.status)) {
		return { retry: `HTTP ${response.status}` };
	}
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for ${url}`);
	}
	const contentType = response.headers.get("content-type") ?? "";
	const buffer = Buffer.from(await response.arrayBuffer());
	const file = join(workDir, `page${extensionForContentType(contentType, url)}`);
	writeFileSync(file, buffer);
	const markdown = await toMarkdown(file, signal);
	if (markdown.trim().length < 200 && contentType.includes("html")) {
		return { retry: "near-empty content (likely JS-rendered)" };
	}
	return { markdown };
}

/** Tier 2: ghost-browser renders the page; DOM HTML is converted. */
async function browserFetch(
	url: string,
	waitSeconds: number,
	signal: AbortSignal | undefined,
	workDir: string,
): Promise<string> {
	const htmlFile = join(workDir, "rendered.html");
	const script = `
import json, time
page = ensure_page()
cdp("Page.navigate", {"url": ${JSON.stringify(url)}}, session_id=page["session_id"])
time.sleep(${waitSeconds})
html = js("document.documentElement.outerHTML")
with open(${JSON.stringify(htmlFile)}, "w") as f:
    f.write(html if isinstance(html, str) else json.dumps(html))
print("BYTES", len(html) if isinstance(html, str) else -1)
`;
	const result = await run("ghost-browser", [], { input: script, timeoutMs: 300_000, signal });
	if (result.code !== 0 || !result.stdout.includes("BYTES")) {
		throw new Error(
			`ghost-browser failed: ${(result.stderr || result.stdout).slice(0, 300)}`,
		);
	}
	return toMarkdown(htmlFile, signal);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL and return its content as Markdown. Handles HTML, PDF, docx, and more. " +
			"Automatically falls back to a stealth browser (ghost-browser) when the page is blocked " +
			"or JS-rendered; set render=true to force the browser.",
		promptSnippet: "Fetch a URL as Markdown via web_fetch (browser fallback for hard pages)",
		promptGuidelines: [
			"Use web_fetch to read a page found via web_search or given by the user; prefer it over curl for pages, PDFs, and documents.",
			"Pass render=true to web_fetch only when a previous fetch of the same URL returned blocked or incomplete content.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch (http/https)" }),
			render: Type.Optional(
				Type.Boolean({
					description: "Force browser rendering (ghost-browser). Default: static fetch with automatic browser fallback.",
				}),
			),
			wait_seconds: Type.Optional(
				Type.Number({
					description: "Seconds to wait after navigation for JS to settle in browser mode (default 3, max 15)",
					minimum: 0,
					maximum: 15,
				}),
			),
			max_chars: Type.Optional(
				Type.Number({
					description: "Truncate returned Markdown to this many characters (default 20000)",
					minimum: 1000,
				}),
			),
			offset: Type.Optional(
				Type.Number({
					description: "Character offset to continue reading a previously truncated result",
					minimum: 0,
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const url = params.url;
			if (!/^https?:\/\//i.test(url)) {
				return {
					content: [{ type: "text", text: "web_fetch: only http/https URLs are supported." }],
					isError: true,
				};
			}
			const workDir = mkdtempSync(join(tmpdir(), "web-fetch-"));
			const waitSeconds = Math.min(params.wait_seconds ?? 3, 15);
			let markdown: string;
			let tier = "static";
			try {
				if (params.render) {
					tier = "browser";
					markdown = await browserFetch(url, waitSeconds, signal, workDir);
				} else {
					const result = await staticFetch(url, signal, workDir);
					if ("markdown" in result) {
						markdown = result.markdown;
					} else {
						tier = `browser (static failed: ${result.retry})`;
						markdown = await browserFetch(url, waitSeconds, signal, workDir);
					}
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `web_fetch failed (${tier}): ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			} finally {
				rmSync(workDir, { recursive: true, force: true });
			}

			const offset = params.offset ?? 0;
			const maxChars = params.max_chars ?? 20_000;
			const total = markdown.length;
			let text = markdown.slice(offset, offset + maxChars);
			if (offset + maxChars < total) {
				text += `\n\n[truncated: showing ${offset}-${offset + maxChars} of ${total} chars — call web_fetch again with offset=${offset + maxChars}]`;
			}
			return {
				content: [{ type: "text", text }],
				details: { url, tier, totalChars: total, offset },
			};
		},
	});
}
