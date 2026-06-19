import type * as v from 'valibot';
import { ToolInputValidationError } from './errors.ts';
import {
	isStandardSchema,
	isTopLevelObjectSchema,
	isValibotSchema,
	parseValibot,
	valibotToJsonSchema,
} from './schema.ts';
import type { ToolDefinition, ToolParameters } from './tool-types.ts';

/**
 * Validates a custom model-callable tool and returns a shallow-frozen,
 * normalized copy.
 *
 * Valibot `parameters` are converted to plain JSON Schema here, once at
 * definition time, and `execute` is wrapped so model-supplied arguments are
 * `v.safeParse`d against the original schema before the user callback runs
 * (see {@link normalizeToolDefinition}). Raw JSON Schema objects pass through
 * unchanged. Tool names are checked for collisions with other active tools
 * when a session assembles its tool list.
 */
export function defineTool<TParams extends ToolParameters>(
	tool: ToolDefinition<TParams>,
): ToolDefinition {
	if (!tool || typeof tool !== 'object') {
		throw new Error('[flue] defineTool() requires a tool definition object.');
	}
	if (typeof tool.name !== 'string' || tool.name.trim().length === 0) {
		throw new Error('[flue] defineTool({ name }) must be a non-empty string.');
	}
	if (typeof tool.description !== 'string' || tool.description.trim().length === 0) {
		throw new Error('[flue] defineTool({ description }) must be a non-empty string.');
	}
	if (!tool.parameters || typeof tool.parameters !== 'object') {
		throw new Error('[flue] defineTool({ parameters }) is required.');
	}
	if (typeof tool.execute !== 'function') {
		throw new Error('[flue] defineTool({ execute }) must be a function.');
	}
	const normalized = normalizeToolDefinition(tool as ToolDefinition);
	return Object.freeze(normalized === (tool as ToolDefinition) ? { ...normalized } : normalized);
}

/**
 * Converted definitions per source definition, so repeated session tool
 * assemblies reuse one stable JSON Schema object. The agent loop caches
 * compiled argument validators by schema object identity, so handing it a
 * fresh conversion per turn would defeat that cache.
 */
const normalizedTools = new WeakMap<ToolDefinition, ToolDefinition>();

/**
 * Normalize a tool definition whose `parameters` is a valibot schema into the
 * plain-JSON-Schema form the agent loop consumes:
 *
 * - `parameters` becomes `toJsonSchema(schema)` (minus `$schema`), converted
 *   once and kept object-stable per definition.
 * - `execute` is wrapped to `v.safeParse` the model-supplied arguments first.
 *   `errorMode: 'ignore'` drops valibot refinements/transforms from the JSON
 *   Schema, so this parse is what enforces them — and it yields the typed,
 *   transformed output for the user callback. Failures throw
 *   {@link ToolInputValidationError}, which the agent loop surfaces to the
 *   model as an error tool-result so it can self-correct.
 *
 * Definitions with raw JSON Schema `parameters` (including everything already
 * normalized here) are returned unchanged. Idempotent; `defineTool()` calls
 * this at definition time, and session tool assembly calls it again to catch
 * inline tool literals that never went through `defineTool()`.
 */
export function normalizeToolDefinition(tool: ToolDefinition): ToolDefinition {
	if (isStandardSchema(tool.parameters) && !isValibotSchema(tool.parameters)) {
		throw new Error(`[flue] Tool "${tool.name}" parameters must use a Valibot schema.`);
	}
	if (!isValibotSchema(tool.parameters)) return tool;
	const cached = normalizedTools.get(tool);
	if (cached) return cached;

	const schema = tool.parameters as v.GenericSchema;
	if (!isTopLevelObjectSchema(schema)) {
		throw new Error(
			`[flue] Tool "${tool.name}" parameters must be a top-level object schema ` +
				'(v.object({ ... })): every LLM provider requires tool arguments to be a JSON object.',
		);
	}
	const parameters = valibotToJsonSchema(schema);
	const execute = tool.execute;
	const normalized: ToolDefinition = {
		...tool,
		parameters,
		async execute(args, signal) {
			const parsed = parseValibot(schema, args);
			if (!parsed.success) {
				throw new ToolInputValidationError({ tool: tool.name, issues: parsed.issues });
			}
			return execute(parsed.output as Record<string, any>, signal);
		},
	};
	normalizedTools.set(tool, normalized);
	return normalized;
}
