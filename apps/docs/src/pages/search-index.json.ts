import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import type { SearchDocument } from '../search/types';

/**
 * Reduces markdown/MDX source to plain text suitable for full-text indexing.
 * This is intentionally a lightweight approximation: minor artifacts are
 * acceptable since the output is only used for search matching and excerpts.
 */
function markdownToPlainText(source: string): string {
	return (
		source
			// MDX import/export statements
			.replace(/^(?:import|export)\s.*$/gm, '')
			// Fenced code blocks: drop the fence lines, keep the code content
			.replace(/^```.*$/gm, '')
			// Inline code
			.replace(/`([^`]*)`/g, '$1')
			// Images and links: keep the alt/label text
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
			.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
			// HTML/JSX tags
			.replace(/<\/?[A-Za-z][^>]*>/g, ' ')
			// Heading markers, blockquotes, list markers, horizontal rules
			.replace(/^#{1,6}\s+/gm, '')
			.replace(/^>\s?/gm, '')
			.replace(/^\s*[-*+]\s+/gm, '')
			.replace(/^\s*\d+\.\s+/gm, '')
			.replace(/^\s*---+\s*$/gm, '')
			// Emphasis: asterisks anywhere, underscores only at word boundaries
			// (so snake_case identifiers survive)
			.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
			.replace(/(^|\s)_{1,3}([^_]+)_{1,3}(?=[\s.,;:!?)]|$)/g, '$1$2')
			// Table pipes
			.replace(/\|/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
	);
}

function extractHeadings(source: string): string {
	const matches = [...source.matchAll(/^#{2,4}\s+(.+)$/gm)];
	return matches.map((match) => markdownToPlainText(match[1] ?? '')).join(' ');
}

export const GET: APIRoute = async () => {
	const entries = await getCollection('docs');

	const documents: SearchDocument[] = entries.map((entry) => ({
		url: `/docs/${entry.id}/`,
		title: entry.data.title,
		description: entry.data.description ?? '',
		headings: extractHeadings(entry.body ?? ''),
		content: markdownToPlainText(entry.body ?? ''),
	}));

	return new Response(JSON.stringify(documents), {
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
	});
};
