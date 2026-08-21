/**
 * youtube-transcript — YouTube transcript tool for pi, backed by Apify's
 * streamers/youtube-scraper actor (official Apify-maintained YouTube scraper).
 *
 * Registers a `youtube_transcript` tool the LLM can call. Requires APIFY_TOKEN
 * in the environment. Each call costs one video event
 * (see https://apify.com/streamers/youtube-scraper).
 *
 * Tuning via env:
 *   YOUTUBE_TRANSCRIPT_TIMEOUT   run-sync timeout in seconds (default: 120)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ACTOR = "streamers~youtube-scraper";

// Actor's supported subtitle languages ("any" lets YouTube pick what exists).
const LANGUAGES = ["any", "en", "de", "es", "fr", "it", "ja", "ko", "nl", "pt", "ru"];

// Transcripts of long videos can be huge; cap what we hand to the model.
const MAX_CHARS = 80_000;

interface SubtitleTrack {
	srtUrl?: string | null;
	type?: string; // "user_generated" | "auto_generated"
	language?: string;
	plaintext?: string;
	srt?: string;
}

interface VideoItem {
	title?: string;
	id?: string;
	url?: string;
	duration?: string;
	date?: string;
	viewCount?: number;
	channelName?: string;
	subtitles?: SubtitleTrack[] | null;
}

const VIDEO_ID_RE = /^[\w-]{11}$/;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "youtube_transcript",
		label: "YouTube Transcript",
		description:
			"Fetch the transcript (subtitles/captions) of a YouTube video, " +
			"plus basic metadata (title, channel, duration). " +
			"Prefers human-made captions, falls back to auto-generated ones.",
		promptSnippet: "Get a YouTube video's transcript via youtube_transcript",
		promptGuidelines: [
			"Use youtube_transcript when the user asks about the content of a YouTube video (summarize, quote, answer questions about it).",
			"Only videos that have captions (human or auto-generated) return a transcript; the tool reports when none exist.",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "YouTube video URL (watch, youtu.be, or shorts) or bare 11-char video ID.",
			}),
			language: Type.Optional(
				Type.String({
					description: `Subtitle language code (${LANGUAGES.join(", ")}). Default 'en'; 'any' takes whatever the video has.`,
				}),
			),
			timestamps: Type.Optional(
				Type.Boolean({
					description: "Return SRT with timestamps instead of plain text (default false).",
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
							text: "youtube_transcript unavailable: APIFY_TOKEN is not set in the environment.",
						},
					],
					isError: true,
				};
			}

			const videoUrl = VIDEO_ID_RE.test(params.url)
				? `https://www.youtube.com/watch?v=${params.url}`
				: params.url;
			const language = params.language && LANGUAGES.includes(params.language) ? params.language : "en";
			const format = params.timestamps ? "srt" : "plaintext";
			const timeout = Number.parseInt(process.env.YOUTUBE_TRANSCRIPT_TIMEOUT ?? "120", 10);

			const input = {
				startUrls: [{ url: videoUrl }],
				downloadSubtitles: true,
				subtitlesLanguage: language,
				subtitlesFormat: format,
				// Safety: if given a channel/playlist URL by mistake, don't scrape it all.
				maxResults: 1,
				maxResultsShorts: 0,
				maxResultStreams: 0,
			};

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
						{ type: "text", text: `youtube_transcript failed: HTTP ${response.status} — ${body}` },
					],
					isError: true,
				};
			}

			const items = (await response.json()) as VideoItem[];
			const item = items[0];
			if (!item) {
				return {
					content: [
						{ type: "text", text: `No video found for ${videoUrl} (private, deleted, or invalid URL?).` },
					],
					isError: true,
				};
			}

			const tracks = item.subtitles ?? [];
			// Prefer human captions over auto-generated; among those, the requested language.
			const byPreference = (want: string) =>
				tracks.find((t) => t.type === want && (language === "any" || t.language === language)) ??
				tracks.find((t) => t.type === want);
			const track = byPreference("user_generated") ?? byPreference("auto_generated") ?? tracks[0];
			const transcript = track?.srt ?? track?.plaintext;

			const header = [
				`Title: ${item.title ?? "(unknown)"}`,
				`Channel: ${item.channelName ?? "(unknown)"}`,
				`Duration: ${item.duration ?? "?"}  Published: ${item.date ?? "?"}  Views: ${item.viewCount ?? "?"}`,
				`URL: ${item.url ?? videoUrl}`,
			];

			if (!transcript) {
				return {
					content: [
						{
							type: "text",
							text: [...header, "", "No transcript available: this video has no captions in the requested language."].join("\n"),
						},
					],
					details: { videoId: item.id, hasTranscript: false },
				};
			}

			header.push(`Transcript (${track?.type ?? "unknown"}, ${track?.language ?? "?"}):`);
			let body = transcript;
			if (body.length > MAX_CHARS) {
				body = `${body.slice(0, MAX_CHARS)}\n\n[transcript truncated at ${MAX_CHARS} characters]`;
			}

			return {
				content: [{ type: "text", text: [...header, "", body].join("\n") }],
				details: {
					videoId: item.id,
					hasTranscript: true,
					trackType: track?.type,
					trackLanguage: track?.language,
					transcriptChars: transcript.length,
				},
			};
		},
	});
}
