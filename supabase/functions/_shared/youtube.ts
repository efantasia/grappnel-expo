// YouTube link handling: URL parsing, oEmbed title lookup, and transcript
// fetching. YouTube materials never touch the Velma transcription job — the
// video's own captions (youtube-transcript-plus) already carry timestamps,
// so the edge function fetches them directly and indexing starts
// immediately. Only the 11-char video id is ever trusted from user input —
// the canonical watch URL is rebuilt from it, so nothing user-controlled
// reaches the caption fetch or guide citation links.

import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
} from 'npm:youtube-transcript-plus@2.0.0';
import type { FetchParams } from 'npm:youtube-transcript-plus@2.0.0';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
]);

// Accepts watch, youtu.be, shorts, live, and embed URLs.
export function parseYouTubeVideoId(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');

  if (host === 'youtu.be') {
    const id = url.pathname.split('/')[1] ?? '';
    return VIDEO_ID_RE.test(id) ? id : null;
  }
  if (YOUTUBE_HOSTS.has(host)) {
    const v = url.searchParams.get('v');
    if (v && VIDEO_ID_RE.test(v)) return v;
    const path = /^\/(embed|shorts|live)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/.exec(url.pathname);
    if (path) return path[2];
  }
  return null;
}

export function canonicalYouTubeUrl(videoId: string): string {
  if (!VIDEO_ID_RE.test(videoId)) throw new Error('Invalid YouTube video id');
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export interface YouTubeLookup {
  title: string | null;
  // Set when YouTube said the video can't be viewed (private/removed) —
  // reject the add instead of creating a material doomed to fail.
  unavailable: boolean;
}

interface CaptionSegment {
  text: string;
  offset: number; // seconds
  duration: number;
}

// Auto-generated caption tracks carry no sentence punctuation, so a
// "sentence" would never end — break on time instead, keeping timestamps
// dense enough to jump close to the right moment.
const SENTENCE_MAX_SECONDS = 30;

// Sentence-final punctuation, optionally wrapped in closing quotes/brackets,
// at a whitespace boundary — so decimals ("3.14") don't split. Abbreviations
// ("Dr.") do, which just adds a harmless extra timestamp.
const SENTENCE_SPLIT_RE = /(?<=[.!?…]["')\]]*)\s+/;
const SENTENCE_END_RE = /[.!?…]["')\]]*$/;

// Caption-only cues like [Music] or [Applause] — dropped so the only
// bracketed tokens in the transcript are our timestamp markers.
const SOUND_TAG_RE = /^\[[^\]]*\]$/;

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// Caption text can carry residual (sometimes double-encoded) HTML entities.
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

// Renders caption segments as one timestamped sentence per entry, blank-line
// separated:
//   [12:04] We can now define the derivative as a limit.
//
//   [12:09] Consider what happens as h approaches zero.
// — the same [m:ss] marker shape the Velma job writes for uploaded media,
// so guide citation handling is identical, but dense enough that citation
// links can jump to the exact sentence in the video. A sentence is stamped
// with the offset of the caption segment it starts in.
export function formatCaptionTranscript(segments: CaptionSegment[]): string {
  const usable = segments
    .map((s) => ({ offset: s.offset, text: decodeEntities(s.text ?? '').trim() }))
    .filter((s) => s.text !== '' && !SOUND_TAG_RE.test(s.text) && Number.isFinite(s.offset))
    .sort((a, b) => a.offset - b.offset);

  const lines: string[] = [];
  let pending: string[] = [];
  let start = 0;
  const flush = () => {
    if (pending.length === 0) return;
    lines.push(`[${formatTimestamp(start)}] ${pending.join(' ')}`);
    pending = [];
  };

  for (const segment of usable) {
    if (pending.length > 0 && segment.offset - start >= SENTENCE_MAX_SECONDS) flush();
    for (const piece of segment.text.split(SENTENCE_SPLIT_RE)) {
      if (piece === '') continue;
      if (pending.length === 0) start = segment.offset;
      pending.push(piece);
      if (SENTENCE_END_RE.test(piece)) flush();
    }
  }
  flush();

  return lines.join('\n\n');
}

// YouTube's public Innertube web API key — shipped in every watch page
// (not a secret) and stable for years. The library fetches the watch page
// solely to scrape this key before calling the Innertube player API; when
// the page can't be fetched at all we hand the library a synthetic response
// carrying the known key so it can still try the player API.
const INNERTUBE_API_KEY_FALLBACK = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

// YouTube aggressively bot-walls datacenter IPs (edge runtimes included)
// with "Sign in to confirm you're not a bot" playability errors on every
// caption surface. The ecosystem-standard fix is routing YouTube traffic
// through a rotating proxy: set the YOUTUBE_PROXY_URL function secret
// (e.g. http://user:pass@p.webshare.io:80) to enable it. Only YouTube
// transcript requests are proxied — Google/GCS calls never are.
interface ProxyOptions {
  proxy: {
    url: string;
    basicAuth?: { username: string; password: string };
  };
}

interface HttpClientLike {
  close?: () => void;
}

// Builds a proxy-bound HTTP client for one fetch attempt, or null when no
// proxy is configured. A fresh client per attempt guarantees fresh proxy
// connections, so a rotating proxy actually rotates between retries.
function createProxyClient(attempt: number): HttpClientLike | null {
  const proxyUrl = Deno.env.get('YOUTUBE_PROXY_URL');
  if (!proxyUrl) return null;
  const createHttpClient = (Deno as unknown as {
    createHttpClient?: (options: ProxyOptions) => HttpClientLike;
  }).createHttpClient;
  if (!createHttpClient) {
    throw new Error('YOUTUBE_PROXY_URL is set but this runtime has no Deno.createHttpClient.');
  }
  // Deno ignores credentials embedded in the proxy URL — they must be
  // passed as basicAuth, so accept the natural user:pass@host form and
  // split it here.
  const parsed = new URL(proxyUrl);
  let username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  parsed.username = '';
  parsed.password = '';
  // Webshare usernames carry a mode suffix: `-rotate` for a new exit IP per
  // request, `-<n>` for a sticky session (residential) or a pinned proxy
  // (datacenter). Advance a numeric suffix on retries so each attempt exits
  // from a different IP; default bare usernames to rotating.
  if (username) {
    const pinned = username.match(/^(.*)-(\d+)$/);
    if (pinned) {
      username = `${pinned[1]}-${Number(pinned[2]) + attempt - 1}`;
    } else if (!username.endsWith('-rotate')) {
      username = `${username}-rotate`;
    }
  }
  return createHttpClient({
    proxy: {
      url: parsed.toString(),
      basicAuth: username ? { username, password } : undefined,
    },
  });
}

// Playability seen on the last watch-page fetch, per video — lets the error
// mapping tell "video has no captions" apart from YouTube's bot wall
// (status LOGIN_REQUIRED / "Sign in to confirm you're not a bot").
const lastPlayability = new Map<string, string>();

// The three fetch hooks youtube-transcript-plus calls (watch page, Innertube
// player, caption XML), all bound to one attempt's HTTP client so they share
// an exit IP.
function makeFetchHooks(client: HttpClientLike | null) {
  const clientFetch = (url: string, init: RequestInit) =>
    fetch(url, (client ? { ...init, client } : init) as RequestInit);

  return {
    videoFetch: async ({ url, userAgent, signal }: FetchParams): Promise<Response> => {
      const videoId = new URL(url).searchParams.get('v') ?? '';
      lastPlayability.delete(videoId);
      try {
        const response = await clientFetch(url, {
          headers: {
            ...(userAgent ? { 'User-Agent': userAgent } : {}),
            // Pre-accepted consent cookie: skips the EU cookie interstitial,
            // which otherwise replaces the page (and the Innertube key).
            Cookie: 'SOCS=CAI',
            'Accept-Language': 'en',
          },
          signal,
        });
        if (response.ok) {
          const body = await response.text();
          const status = body.match(/"playabilityStatus":\s*\{\s*"status":\s*"([A-Z_]+)"/)?.[1];
          if (status) lastPlayability.set(videoId, status);
          return new Response(body, { status: 200 });
        }
        lastPlayability.set(videoId, `HTTP_${response.status}`);
        await response.body?.cancel();
      } catch {
        // Treat network failures like a blocked page and fall through.
      }
      return new Response(`"INNERTUBE_API_KEY":"${INNERTUBE_API_KEY_FALLBACK}"`, { status: 200 });
    },

    playerFetch: ({ url, method, body, headers, userAgent, signal }: FetchParams) =>
      clientFetch(url, {
        method: method ?? 'POST',
        headers: { ...(headers ?? {}), ...(userAgent ? { 'User-Agent': userAgent } : {}) },
        body,
        signal,
      }),

    transcriptFetch: ({ url, userAgent, signal }: FetchParams) =>
      clientFetch(url, {
        headers: userAgent ? { 'User-Agent': userAgent } : {},
        signal,
      }),
  };
}

// YouTube flags a share of any proxy pool too; with a rotating proxy each
// attempt exits from a fresh IP, so a handful of tries rides past the
// bot-walled ones. Without a proxy the egress IP is fixed and retrying is
// pointless.
const PROXY_ATTEMPTS = 5;

const NO_CAPTIONS_MESSAGE =
  'This video has no captions/transcript on YouTube, so it can’t be added as a source.';

// Fetches the video's caption track and returns it as a timestamped
// transcript. Throws user-presentable errors.
export async function fetchYouTubeTranscript(videoId: string): Promise<string> {
  if (!VIDEO_ID_RE.test(videoId)) throw new Error('Invalid YouTube video id');

  const proxied = Boolean(Deno.env.get('YOUTUBE_PROXY_URL'));
  const attempts = proxied ? PROXY_ATTEMPTS : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const client = createProxyClient(attempt);
    let segments: CaptionSegment[];
    try {
      segments = (await fetchTranscript(videoId, makeFetchHooks(client))) as CaptionSegment[];
    } catch (err) {
      const playability = lastPlayability.get(videoId);
      // The mapped messages are user-facing; keep raw failures in the logs.
      console.error(
        `Transcript fetch attempt ${attempt}/${attempts} for ${videoId} failed (playability: ${playability ?? 'unknown'}):`,
        err,
      );
      // Playability OK with captions declared absent is YouTube's definitive
      // answer — not a bot wall; retrying won't change it.
      if (err instanceof YoutubeTranscriptDisabledError && playability === 'OK') {
        throw new Error(NO_CAPTIONS_MESSAGE);
      }
      if (
        err instanceof YoutubeTranscriptDisabledError ||
        err instanceof YoutubeTranscriptNotAvailableError ||
        err instanceof YoutubeTranscriptVideoUnavailableError ||
        err instanceof YoutubeTranscriptTooManyRequestError ||
        err instanceof TypeError // network/proxy failure — worth a fresh IP
      ) {
        lastError = err;
        continue;
      }
      throw err;
    } finally {
      client?.close?.();
    }

    const transcript = formatCaptionTranscript(segments ?? []);
    if (!transcript) {
      throw new Error('This video’s transcript is empty — it may contain no speech.');
    }
    return transcript;
  }

  // All attempts failed. A bot-walled watch page reports LOGIN_REQUIRED
  // ("Sign in to confirm you're not a bot") and yields the same library
  // errors as a video with no captions — playability tells them apart.
  // Callers verified the video exists via oEmbed before this.
  const playability = lastPlayability.get(videoId);
  if (playability !== undefined && playability !== 'OK') {
    throw new Error(
      proxied
        ? 'YouTube blocked every transcript attempt ("confirm you’re not a bot") — try again in a few minutes.'
        : 'YouTube blocked the transcript request from the server ("confirm you’re not a bot"). Try again later — or set the YOUTUBE_PROXY_URL function secret to a rotating proxy to fix this permanently.',
    );
  }
  if (lastError instanceof TypeError) {
    throw new Error(
      'Could not reach YouTube through the configured proxy — check the YOUTUBE_PROXY_URL secret.',
    );
  }
  if (lastError instanceof YoutubeTranscriptVideoUnavailableError) {
    throw new Error('This YouTube video is unavailable — double-check the link.');
  }
  if (lastError instanceof YoutubeTranscriptTooManyRequestError) {
    throw new Error(
      'YouTube is rate-limiting transcript requests right now — try again in a few minutes.',
    );
  }
  throw new Error(NO_CAPTIONS_MESSAGE);
}

// Title via the public oEmbed endpoint — no API key, and it works for
// unlisted videos. Network hiccups degrade to a fallback title rather than
// blocking the add.
export async function lookupYouTubeVideo(videoId: string): Promise<YouTubeLookup> {
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalYouTubeUrl(videoId))}&format=json`,
    );
    if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
      await response.body?.cancel();
      return { title: null, unavailable: true };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { title: null, unavailable: false };
    }
    const data = await response.json();
    const title = typeof data.title === 'string' ? data.title.trim().slice(0, 200) : '';
    return { title: title || null, unavailable: false };
  } catch {
    return { title: null, unavailable: false };
  }
}
