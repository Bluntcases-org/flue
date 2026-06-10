/**
 * One document in the docs search index, emitted at build time by
 * `src/pages/search-index.json.ts` and consumed by the search endpoint
 * in `src/worker.ts`.
 */
export interface SearchDocument {
	/** Site-relative URL of the page, e.g. `/docs/concepts/agents/`. */
	url: string;
	title: string;
	description: string;
	/** Plain text of all section headings, space-joined. */
	headings: string;
	/** Plain text of the page body. */
	content: string;
}
