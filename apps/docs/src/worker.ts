import MiniSearch from 'minisearch';
import type { SearchDocument } from './search/types';

interface MarkdownConversionResult {
	format: 'markdown' | 'error';
	data?: string;
	error?: string;
	tokens?: number;
}

interface Env {
	ASSETS: {
		fetch(request: Request): Promise<Response>;
	};
	AI: {
		toMarkdown(
			document: { name: string; blob: Blob },
			options?: { conversionOptions?: { html?: { hostname?: string; cssSelector?: string } } },
		): Promise<MarkdownConversionResult>;
	};
}

function isMarkdownRequest(request: Request, url: URL) {
	return (
		(request.method === 'GET' || request.method === 'HEAD') && url.pathname.endsWith('/index.md')
	);
}

const SEARCH_INDEX_PATH = '/docs/search-index.json';
const DEFAULT_RESULT_LIMIT = 8;
const MAX_RESULT_LIMIT = 25;
const EXCERPT_RADIUS = 120;
const CACHE_CONTROL = 'public, max-age=600';

// Cached per isolate; the index only changes with a new deployment.
let searchIndexPromise: Promise<MiniSearch<SearchDocument>> | null = null;

function loadSearchIndex(env: Env, origin: string): Promise<MiniSearch<SearchDocument>> {
	searchIndexPromise ??= (async () => {
		const response = await env.ASSETS.fetch(new Request(`${origin}${SEARCH_INDEX_PATH}`));
		if (!response.ok) {
			throw new Error(`Failed to load search index (status ${response.status}).`);
		}
		const documents = (await response.json()) as SearchDocument[];
		const index = new MiniSearch<SearchDocument>({
			idField: 'url',
			fields: ['title', 'headings', 'description', 'content'],
			storeFields: ['title', 'description', 'content'],
			searchOptions: {
				boost: { title: 4, headings: 3, description: 2 },
				prefix: true,
				fuzzy: 0.2,
			},
		});
		index.addAll(documents);
		return index;
	})();
	searchIndexPromise.catch(() => {
		searchIndexPromise = null;
	});
	return searchIndexPromise;
}

function buildExcerpt(content: string, terms: string[]): string {
	const lowered = content.toLowerCase();
	let position = -1;
	for (const term of terms) {
		const index = lowered.indexOf(term.toLowerCase());
		if (index !== -1 && (position === -1 || index < position)) {
			position = index;
		}
	}
	if (position === -1) {
		position = 0;
	}

	const start = Math.max(0, position - EXCERPT_RADIUS);
	const end = Math.min(content.length, position + EXCERPT_RADIUS);
	const prefix = start > 0 ? '…' : '';
	const suffix = end < content.length ? '…' : '';
	return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

function searchResponseHeaders(status: number): Headers {
	const headers = new Headers({
		'Content-Type': 'application/json; charset=utf-8',
		'Access-Control-Allow-Origin': '*',
	});
	if (status === 200) {
		headers.set('Cache-Control', CACHE_CONTROL);
	}
	return headers;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: searchResponseHeaders(status) });
}

async function handleSearch(request: Request, env: Env, url: URL): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, HEAD' } });
	}

	const query = url.searchParams.get('q')?.trim();
	if (!query) {
		return jsonResponse({ error: 'Missing required query parameter "q".' }, 400);
	}

	const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
	const limit = Number.isNaN(limitParam)
		? DEFAULT_RESULT_LIMIT
		: Math.min(Math.max(limitParam, 1), MAX_RESULT_LIMIT);

	let index: MiniSearch<SearchDocument>;
	try {
		index = await loadSearchIndex(env, url.origin);
	} catch {
		return jsonResponse({ error: 'Search index is unavailable.' }, 500);
	}

	const results = index
		.search(query)
		.slice(0, limit)
		.map((result) => ({
			url: result.id as string,
			title: result.title as string,
			description: (result.description as string) || undefined,
			excerpt: buildExcerpt((result.content as string) ?? '', result.terms),
			score: Math.round(result.score * 100) / 100,
		}));

	if (request.method === 'HEAD') {
		return new Response(null, { headers: searchResponseHeaders(200) });
	}

	return jsonResponse({ query, results });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/docs/search' || url.pathname === '/docs/search/') {
			return handleSearch(request, env, url);
		}

		if (!isMarkdownRequest(request, url)) {
			return env.ASSETS.fetch(request);
		}

		url.pathname = url.pathname.slice(0, -'index.md'.length);
		const page = await env.ASSETS.fetch(new Request(url));

		if (!page.ok) {
			return page;
		}

		const result = await env.AI.toMarkdown(
			{
				name: 'page.html',
				blob: new Blob([await page.arrayBuffer()], { type: 'text/html' }),
			},
			{
				conversionOptions: {
					html: {
						hostname: url.origin,
						cssSelector: '[data-markdown-content], [data-markdown-navigation]',
					},
				},
			},
		);

		if (result.format === 'error') {
			return new Response(result.error ?? 'Unable to convert page to Markdown.', { status: 502 });
		}

		const headers = new Headers({
			'Content-Type': 'text/markdown; charset=utf-8',
			'Cache-Control': CACHE_CONTROL,
		});

		if (result.tokens !== undefined) {
			headers.set('X-Markdown-Tokens', result.tokens.toString());
		}

		return new Response(request.method === 'HEAD' ? null : result.data, { headers });
	},
};
