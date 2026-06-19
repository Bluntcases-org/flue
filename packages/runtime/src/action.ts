import type * as v from 'valibot';
import { ActionInputValidationError, ActionOutputValidationError } from './errors.ts';
import {
	isTopLevelObjectSchema,
	isValibotSchema,
	parseValibot,
	type ReadonlyJsonSchema,
	valibotToJsonSchema,
} from './schema.ts';
import type { FlueHarness, FlueLogger } from './types.ts';

const definedActions = new WeakSet<object>();

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ActionInputSchema = v.GenericSchema<Record<string, unknown>, unknown>;

export type ActionContext<S extends ActionInputSchema | undefined> = {
	readonly harness: FlueHarness;
	readonly log: FlueLogger;
} & (S extends ActionInputSchema ? { readonly input: v.InferOutput<S> } : {});

type ActionRunResult<S extends v.GenericSchema | undefined> = S extends v.GenericSchema
	? v.InferInput<S>
	: JsonValue | undefined;

export interface ActionDefinition<
	TInput extends ActionInputSchema | undefined = ActionInputSchema | undefined,
	TOutput extends v.GenericSchema | undefined = v.GenericSchema | undefined,
> {
	readonly __flueAction: true;
	readonly name: string;
	readonly description: string;
	readonly input: TInput;
	readonly output: TOutput;
	readonly inputJsonSchema: TInput extends ActionInputSchema ? ReadonlyJsonSchema : undefined;
	run(context: ActionContext<TInput>): ActionRunResult<TOutput> | Promise<ActionRunResult<TOutput>>;
}

export type ActionInput<TAction extends ActionDefinition> = TAction extends ActionDefinition<
	infer TInput,
	any
>
	? TInput extends ActionInputSchema
		? v.InferInput<TInput>
		: never
	: never;

export type ActionOutput<TAction extends ActionDefinition> = TAction extends ActionDefinition<
	any,
	infer TOutput
>
	? TOutput extends v.GenericSchema
		? v.InferOutput<TOutput>
		: unknown
	: never;

type ActionOptions<
	TInput extends ActionInputSchema | undefined,
	TOutput extends v.GenericSchema | undefined,
> = {
	name: string;
	description: string;
	input?: TInput;
	output?: TOutput;
	run(context: ActionContext<TInput>): ActionRunResult<TOutput> | Promise<ActionRunResult<TOutput>>;
};

export function defineAction<
	const TInput extends ActionInputSchema | undefined = undefined,
	const TOutput extends v.GenericSchema | undefined = undefined,
>(options: ActionOptions<TInput, TOutput>): ActionDefinition<TInput, TOutput> {
	if (!options || typeof options !== 'object') {
		throw new Error('[flue] defineAction() requires an action definition object.');
	}
	assertNonEmptyString(options.name, 'defineAction({ name })');
	assertNonEmptyString(options.description, 'defineAction({ description })');
	if (options.input !== undefined) {
		if (!isValibotSchema(options.input)) {
			throw new Error('[flue] defineAction({ input }) must be a Valibot schema.');
		}
		if (!isTopLevelObjectSchema(options.input)) {
			throw new Error('[flue] defineAction({ input }) must be a top-level object schema.');
		}
	}
	if (options.output !== undefined && !isValibotSchema(options.output)) {
		throw new Error('[flue] defineAction({ output }) must be a Valibot schema.');
	}
	if (typeof options.run !== 'function') {
		throw new Error('[flue] defineAction({ run }) must be a function.');
	}
	const action = Object.freeze({
		__flueAction: true as const,
		name: options.name,
		description: options.description,
		input: options.input as TInput,
		output: options.output as TOutput,
		inputJsonSchema: (options.input ? valibotToJsonSchema(options.input) : undefined) as ActionDefinition<
			TInput,
			TOutput
		>['inputJsonSchema'],
		run: options.run,
	});
	definedActions.add(action);
	return action;
}

export function isActionDefinition(value: unknown): value is ActionDefinition {
	return Boolean(value && typeof value === 'object' && definedActions.has(value));
}

export async function validateAndRunAction<TAction extends ActionDefinition>(
	action: TAction,
	context: { harness: FlueHarness; log: FlueLogger },
	input?: unknown,
): Promise<ActionOutput<TAction>> {
	let parsedInput: unknown;
	if (action.input) {
		const parsed = parseValibot(action.input, input);
		if (!parsed.success) throw new ActionInputValidationError({ action: action.name, issues: parsed.issues });
		parsedInput = parsed.output;
	}
	const runContext = action.input ? { ...context, input: parsedInput } : context;
	const result = await action.run(runContext as never);
	if (!action.output) return result as ActionOutput<TAction>;
	const parsed = parseValibot(action.output, result);
	if (!parsed.success) throw new ActionOutputValidationError({ action: action.name, issues: parsed.issues });
	return parsed.output as ActionOutput<TAction>;
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`[flue] ${label} must be a non-empty string.`);
	}
}
