/**
 * web-search — Google web search tool for pi, backed by Apify's
 * apify/google-search-scraper actor (real Google SERP, not a search API index).
 *
 * Registers a `web_search` tool the LLM can call. Requires APIFY_TOKEN in the
 * environment. Each call costs one search-page-scraped event per SERP page
 * (see https://apify.com/apify/google-search-scraper).
 *
 * Tuning via env:
 *   WEB_SEARCH_COUNTRY   ISO country code for the search (default: none/global)
 *   WEB_SEARCH_TIMEOUT   run-sync timeout in seconds (default: 120)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ACTOR = "apify~google-search-scraper";

interface OrganicResult {
	title?: string;
	url?: string;
	description?: string;
	date?: string;
}

interface SerpItem {
	searchQuery?: { term?: string };
	resultsTotal?: number;
	organicResults?: OrganicResult[];
	peopleAlsoAsk?: { question?: string; answer?: string }[];
	relatedQueries?: { title?: string }[];
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search Google and return organic results (title, URL, snippet). " +
			"Supports Google operators in the query (site:, filetype:, quotes, etc.).",
		promptSnippet: "Search Google for current information via web_search",
		promptGuidelines: [
			"Use web_search when the answer may have changed after your training data, or when the user asks about current events, versions, prices, or niche facts.",
			"web_search returns snippets only; fetch a promising URL (e.g. with curl via bash) when the snippet is not enough.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query. Google operators allowed (site:, filetype:, \"exact\").",
			}),
			max_results: Type.Optional(
				Type.Number({
					description: "Maximum organic results to return (1-20, default 10)",
					minimum: 1,
					maximum: 20,
				}),
			),
			country: Type.Optional(
				Type.String({
					description: "ISO 3166 alpha-2 country code for localized results (e.g. 'de', 'fr')",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const token = process.env.APIFY_TOKEN;
			if (!token) {
				return {
					content: [
						{ type: "text", text: "web_search unavailable: APIFY_TOKEN is not set in the environment." },
					],
					isError: true,
				};
			}

			const maxResults = Math.min(Math.max(params.max_results ?? 10, 1), 20);
			const timeout = Number.parseInt(process.env.WEB_SEARCH_TIMEOUT ?? "120", 10);
			const country = params.country ?? process.env.WEB_SEARCH_COUNTRY;

			const input: Record<string, unknown> = {
				queries: params.query,
				maxPagesPerQuery: 1,
				resultsPerPage: maxResults,
			};
			if (country) input.countryCode = country.toLowerCase();

			const url =
				`https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?timeout=${timeout}`;
			const response = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(input),
				signal,
			});

			if (!response.ok) {
				const body = (await response.text()).slice(0, 300);
				return {
					content: [
						{ type: "text", text: `web_search failed: HTTP ${response.status} — ${body}` },
					],
					isError: true,
				};
			}

			const items = (await response.json()) as SerpItem[];
			const item = items[0];
			if (!item) {
				return { content: [{ type: "text", text: "No results returned." }], details: {} };
			}

			const lines: string[] = [];
			const organic = (item.organicResults ?? []).slice(0, maxResults);
			if (organic.length === 0) {
				lines.push("No organic results.");
			}
			for (const [i, r] of organic.entries()) {
				lines.push(`${i + 1}. ${r.title ?? "(untitled)"}`);
				lines.push(`   ${r.url ?? ""}`);
				if (r.description) lines.push(`   ${r.description}`);
				if (r.date) lines.push(`   (${r.date})`);
			}

			const paa = (item.peopleAlsoAsk ?? []).slice(0, 3);
			if (paa.length > 0) {
				lines.push("");
				lines.push("People also ask:");
				for (const q of paa) {
					lines.push(`- ${q.question ?? ""}`);
				}
			}

			const related = (item.relatedQueries ?? []).slice(0, 5);
			if (related.length > 0) {
				lines.push("");
				lines.push(`Related: ${related.map((r) => r.title).filter(Boolean).join(" | ")}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					query: params.query,
					resultsTotal: item.resultsTotal,
					resultCount: organic.length,
				},
			};
		},
	});
}
