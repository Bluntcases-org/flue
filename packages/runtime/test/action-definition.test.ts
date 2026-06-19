import * as v from 'valibot';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
	ActionInputValidationError,
	ActionOutputValidationError,
	createAgent,
	createWorkflow,
	defineAction,
	defineTool,
	type FlueHarness,
	type FlueLogger,
} from '../src/index.ts';
import { validateAndRunAction } from '../src/action.ts';

const harness = {} as FlueHarness;
const log = {} as FlueLogger;

describe('defineAction()', () => {
	it('validates and transforms action input and output when schemas are declared', async () => {
		const run = vi.fn(async ({ input }: { input: { count: number } }) => String(input.count));
		const action = defineAction({
			name: 'format_count',
			description: 'Formats a count.',
			input: v.object({ count: v.pipe(v.string(), v.transform(Number)) }),
			output: v.pipe(v.string(), v.transform((value) => ({ value }))),
			run,
		});

		await expect(validateAndRunAction(action, { harness, log }, { count: '3' })).resolves.toEqual({
			value: '3',
		});
		expect(run).toHaveBeenCalledWith({ harness, log, input: { count: 3 } });
	});

	it('throws a structured input error before running when action input is invalid', async () => {
		const run = vi.fn(async () => undefined);
		const action = defineAction({
			name: 'review',
			description: 'Reviews input.',
			input: v.object({ repository: v.string() }),
			run,
		});

		const result = validateAndRunAction(action, { harness, log }, { repository: 7 });

		await expect(result).rejects.toBeInstanceOf(ActionInputValidationError);
		await expect(result).rejects.toMatchObject({
			type: 'action_input_validation',
			meta: {
				action: 'review',
				issues: [{ path: ['repository'] }],
			},
		});
		expect(run).not.toHaveBeenCalled();
	});

	it('throws a structured output error when action output is invalid', async () => {
		const action = defineAction({
			name: 'count',
			description: 'Returns a count.',
			output: v.object({ count: v.number() }),
			run: async () => ({ count: 'invalid' } as never),
		});

		await expect(validateAndRunAction(action, { harness, log })).rejects.toBeInstanceOf(
			ActionOutputValidationError,
		);
		await expect(validateAndRunAction(action, { harness, log })).rejects.toMatchObject({
			type: 'action_output_validation',
			meta: { action: 'count', issues: [{ path: ['count'] }] },
		});
	});

	it('rejects non-Valibot Standard Schemas before conversion', () => {
		const standardSchema = {
			'~standard': {
				version: 1,
				vendor: 'other',
				validate: () => ({ value: {} }),
			},
		};

		expect(() =>
			defineAction({
				name: 'foreign',
				description: 'Foreign schema.',
				input: standardSchema as never,
				run: async () => undefined,
			}),
		).toThrow('must be a Valibot schema');
	});

	it('rejects non-object action input schemas', () => {
		expect(() =>
			defineAction({
				name: 'invalid',
				description: 'Invalid input.',
				input: v.string() as never,
				run: async () => undefined,
			}),
		).toThrow('top-level object schema');
	});

	it('reuses one deeply frozen JSON Schema object for a shared Valibot schema', () => {
		const input = v.object({ value: v.string() });
		const first = defineAction({
			name: 'first',
			description: 'First action.',
			input,
			run: async () => undefined,
		});
		const second = defineAction({
			name: 'second',
			description: 'Second action.',
			input,
			run: async () => undefined,
		});

		expect(second.inputJsonSchema).toBe(first.inputJsonSchema);
		expect(Object.isFrozen(first.inputJsonSchema)).toBe(true);
		expect(Object.isFrozen(first.inputJsonSchema.properties)).toBe(true);
		expect(() => {
			(first.inputJsonSchema as Record<string, unknown>).type = 'string';
		}).toThrow(TypeError);
		expect(second.inputJsonSchema.type).toBe('object');
		const tool = defineTool({
			name: 'shared',
			description: 'Uses the shared schema.',
			parameters: input,
			execute: async () => 'ok',
		});
		expect(tool.parameters).toBe(first.inputJsonSchema);
	});

	it('infers transformed context input and output while omitting undeclared input', () => {
		defineAction({
			name: 'typed',
			description: 'Typed action.',
			input: v.object({ count: v.pipe(v.string(), v.transform(Number)) }),
			output: v.object({ accepted: v.boolean() }),
			run: async (context) => {
				expectTypeOf(context.input).toEqualTypeOf<{ count: number }>();
				return { accepted: context.input.count > 0 };
			},
		});
		defineAction({
			name: 'untyped_output',
			description: 'Unknown output action.',
			run: async (context) => {
				expectTypeOf(context).not.toHaveProperty('input');
				return { accepted: true };
			},
		});
	});
});

describe('createWorkflow()', () => {
	it('creates extracted and inline branded workflows with required agents', () => {
		const agent = createAgent(() => ({ model: false }));
		const action = defineAction({
			name: 'review',
			description: 'Reviews input.',
			run: async () => undefined,
		});

		const extracted = createWorkflow({ agent, action });
		const inline = createWorkflow({
			agent,
			input: v.object({ repository: v.string() }),
			run: async ({ input }) => input.repository,
		});

		expect(extracted).toMatchObject({ __flueCreatedWorkflow: true, agent, action });
		expect(inline).toMatchObject({ __flueCreatedWorkflow: true, agent });
		expect(inline).not.toHaveProperty('name');
		expect(inline).not.toHaveProperty('description');
	});

	it('rejects forged Created Agent and Action brands', () => {
		const agent = createAgent(() => ({ model: false }));
		const action = defineAction({
			name: 'review',
			description: 'Reviews input.',
			run: async () => undefined,
		});
		const forgedAgent = { __flueCreatedAgent: true, initialize: async () => ({ model: false }) };
		const forgedAction = {
			__flueAction: true,
			name: 'forged',
			description: 'Forged action.',
			input: undefined,
			output: undefined,
			inputJsonSchema: undefined,
			run: async () => undefined,
		};

		expect(() => createWorkflow({ agent: forgedAgent, action } as never)).toThrow('CreatedAgent');
		expect(() => createWorkflow({ agent, action: forgedAction } as never)).toThrow('Action');
	});

	it('rejects definitions that provide both an action and inline run', () => {
		const agent = createAgent(() => ({ model: false }));
		const action = defineAction({
			name: 'review',
			description: 'Reviews input.',
			run: async () => undefined,
		});

		expect(() => createWorkflow({ agent, action, run: async () => undefined } as never)).toThrow(
			'exactly one',
		);
	});
});
