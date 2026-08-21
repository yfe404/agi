/**
 * youtube-search — YouTube search tool for pi, backed by Apify's
 * streamers/youtube-scraper actor (official Apify-maintained YouTube scraper).
 *
 * Registers a `youtube_search` tool the LLM can call. Requires APIFY_TOKEN in
 * the environment. Each returned video costs one video event
 * (see https://apify.com/streamers/youtube-scraper).
 *
 * Tuning via env:
 *   YOUTUBE_SEARCH_TIMEOUT   run-sync timeout in seconds (default: 120)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ACTOR = "streamers~youtube-scraper";

const SORT_ORDERS = ["relevance", "rating", "date", "views"];
const DATE_FILTERS = ["hour", "today", "week", "month", "year"];

interface VideoItem {
	order?: number;
	title?: string;
	id?: string;
	url?: string;
	duration?: string;
	date?: string;
	viewCount?: number;
	channelName?: string;
	numberOfSubscribers?: number;
	text?: string | null;
}

/** First ~200 chars of the description, whitespace collapsed to one line. */
function snippet(text: string | null | undefined): string | undefined {
	const oneLine = text?.replace(/\s+/g, " ").trim();
	if (!oneLine) return undefined;
	return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "youtube_search",
		label: "YouTube Search",
		description:
			"Search YouTube and return matching videos: title, URL, channel, " +
			"duration, views, publish date, and a description snippet.",
		promptSnippet: "Search YouTube videos via youtube_search",
		promptGuidelines: [
			"Use youtube_search to find videos on a topic; pair with youtube_transcript to read a found video's content.",
			"Each returned video is billed, so keep max_results small unless the user needs many.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search terms, as you would type them into YouTube's search bar.",
			}),
			max_results: Type.Optional(
				Type.Number({
					description: "Maximum videos to return (1-20, default 10). Each result is billed.",
					minimum: 1,
					maximum: 20,
				}),
			),
			sort: Type.Optional(
				Type.String({
					description: `Sorting order: ${SORT_ORDERS.join(", ")} (default relevance).`,
				}),
			),
			uploaded: Type.Optional(
				Type.String({
					description: `Only videos uploaded within: ${DATE_FILTERS.join(", ")}.`,
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const token = process.env.APIFY_TOKEN;
			if (!token) {
				return {
					content: [
						{
							type: "text",
							text: "youtube_search unavailable: APIFY_TOKEN is not set in the environment.",
						},
					],
					isError: true,
				};
			}

			const maxResults = Math.min(Math.max(params.max_results ?? 10, 1), 20);
			const timeout = Number.parseInt(process.env.YOUTUBE_SEARCH_TIMEOUT ?? "120", 10);

			const input: Record<string, unknown> = {
				searchQueries: [params.query],
				maxResults,
				maxResultsShorts: 0,
				maxResultStreams: 0,
			};
			if (params.sort && SORT_ORDERS.includes(params.sort)) input.sortingOrder = params.sort;
			if (params.uploaded && DATE_FILTERS.includes(params.uploaded)) input.dateFilter = params.uploaded;

			const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?timeout=${timeout}`;
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
						{ type: "text", text: `youtube_search failed: HTTP ${response.status} — ${body}` },
					],
					isError: true,
				};
			}

			const items = (await response.json()) as VideoItem[];
			const videos = items
				.filter((v) => v.url)
				.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
				.slice(0, maxResults);

			if (videos.length === 0) {
				return { content: [{ type: "text", text: "No videos found." }], details: { resultCount: 0 } };
			}

			const lines: string[] = [];
			for (const [i, v] of videos.entries()) {
				lines.push(`${i + 1}. ${v.title ?? "(untitled)"}${v.duration ? ` (${v.duration})` : ""}`);
				lines.push(`   ${v.url}`);
				const meta = [
					v.channelName,
					v.viewCount != null ? `${v.viewCount.toLocaleString("en-US")} views` : undefined,
					v.date?.slice(0, 10),
				].filter(Boolean);
				if (meta.length > 0) lines.push(`   ${meta.join(" — ")}`);
				const desc = snippet(v.text);
				if (desc) lines.push(`   ${desc}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { query: params.query, resultCount: videos.length },
			};
		},
	});
}
