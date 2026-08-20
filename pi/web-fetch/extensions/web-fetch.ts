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
	scrolls: number,
	signal: AbortSignal | undefined,
	workDir: string,
): Promise<string> {
	const htmlFile = join(workDir, "rendered.html");
	const script = `
import json, time
page = ensure_page()
cdp("Page.navigate", {"url": ${JSON.stringify(url)}}, session_id=page["session_id"])
time.sleep(${waitSeconds})
# Scroll to trigger lazy/infinite-scroll content; stop when height stabilizes.
last_height = 0
for _ in range(${scrolls}):
    js("window.scrollTo(0, document.body.scrollHeight)")
    time.sleep(1.5)
    height = js("document.body.scrollHeight")
    if not isinstance(height, (int, float)) or height == last_height:
        break
    last_height = height
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

/**
 * Render cache: pagination must slice the SAME document across calls, so the
 * converted Markdown is kept per URL. Small LRU with TTL; refresh=true bypasses.
 */
interface CacheEntry {
	markdown: string;
	tier: string;
	at: number;
}
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 20;
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): CacheEntry | undefined {
	const entry = cache.get(key);
	if (!entry) return undefined;
	if (Date.now() - entry.at > CACHE_TTL_MS) {
		cache.delete(key);
		return undefined;
	}
	// LRU touch: re-insert to move to the end of iteration order.
	cache.delete(key);
	cache.set(key, entry);
	return entry;
}

/**
 * Remove link/image syntax, keeping display text. Cuts token noise on
 * link-dense pages (indexes, tables) where URLs dominate the Markdown.
 */
function stripLinks(markdown: string): string {
	return (
		markdown
			// images: ![alt](src) -> alt
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			// links: [text](href) -> text (repeat for nested [a [b](c)](d) cases)
			.replace(/\[([^\][]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\][]*)\]\([^)]*\)/g, "$1")
			// reference-style links: [text][ref] -> text
			.replace(/\[([^\][]*)\]\[[^\]]*\]/g, "$1")
			// bare autolinks: <https://...> -> (removed)
			.replace(/<https?:\/\/[^>]+>/g, "")
			// drop table rows that are only pipes/whitespace after link removal
			.replace(/^[|\s-]+$/gm, "")
			// collapse whitespace bloat left behind
			.replace(/[ \t]{3,}/g, " ")
			.replace(/\n{4,}/g, "\n\n\n")
	);
}

function cacheSet(key: string, entry: CacheEntry): void {
	cache.delete(key);
	cache.set(key, entry);
	while (cache.size > CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
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
			"Pass text_only=true to web_fetch for link-dense pages (news indexes, listings) when you need the text, not the URLs.",
			"Pass scroll=N (e.g. 5) to web_fetch for infinite-scroll pages like Reddit feeds or social timelines when the initial content is incomplete.",
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
					description: "Truncate returned Markdown to this many characters (default 20000, values below 500 are clamped up to 500)",
					minimum: 1,
				}),
			),
			offset: Type.Optional(
				Type.Number({
					description: "Character offset to continue reading a previously truncated result",
					minimum: 0,
				}),
			),
			refresh: Type.Optional(
				Type.Boolean({
					description: "Bypass the fetch cache and re-fetch the page (default false; results are cached ~10 min so offset pagination slices a consistent document)",
				}),
			),
			text_only: Type.Optional(
				Type.Boolean({
					description: "Strip all links and images from the Markdown, keeping only their text. Use for link-dense pages (news indexes, tables) to cut token noise. Default false.",
				}),
			),
			scroll: Type.Optional(
				Type.Number({
					description: "Browser mode only: scroll to the bottom up to N times (1.5s pause each) to load lazy/infinite-scroll content (e.g. Reddit feeds). Stops early when page height stabilizes. Default 0, max 20. Implies render=true.",
					minimum: 0,
					maximum: 20,
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
			const scrolls = Math.min(Math.max(params.scroll ?? 0, 0), 20);
			const forceBrowser = params.render || scrolls > 0;
			const cacheKey = `${forceBrowser ? "browser" : "auto"}:scroll${scrolls}:${url}`;
			let markdown: string;
			let tier: string;
			const cached = params.refresh ? undefined : cacheGet(cacheKey);
			if (cached) {
				markdown = cached.markdown;
				tier = `${cached.tier} (cached)`;
			} else {
				const workDir = mkdtempSync(join(tmpdir(), "web-fetch-"));
				const waitSeconds = Math.min(params.wait_seconds ?? 3, 15);
				tier = "static";
				try {
					if (forceBrowser) {
						tier = scrolls > 0 ? `browser (${scrolls} scrolls max)` : "browser";
						markdown = await browserFetch(url, waitSeconds, scrolls, signal, workDir);
					} else {
						const result = await staticFetch(url, signal, workDir);
						if ("markdown" in result) {
							markdown = result.markdown;
						} else {
							tier = `browser (static failed: ${result.retry})`;
							markdown = await browserFetch(url, waitSeconds, 0, signal, workDir);
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
				cacheSet(cacheKey, { markdown, tier, at: Date.now() });
			}

			const body = params.text_only ? stripLinks(markdown) : markdown;
			const offset = params.offset ?? 0;
			const maxChars = Math.max(params.max_chars ?? 20_000, 500);
			const total = body.length;
			let text = body.slice(offset, offset + maxChars);
			if (offset + maxChars < total) {
				text += `\n\n[truncated: showing ${offset}-${offset + maxChars} of ${total} chars — call web_fetch again with offset=${offset + maxChars}${params.text_only ? " and text_only=true" : ""}]`;
			}
			// The LLM only sees `content`, so prepend fetch provenance when it is
			// surprising (fallback or cache) — the model should know a static fetch
			// was blocked or that it is reading a cached snapshot.
			if (tier !== "static") {
				text = `[fetched via ${tier}]\n${text}`;
			}
			return {
				content: [{ type: "text", text }],
				details: { url, tier, totalChars: total, offset },
			};
		},
	});
}
