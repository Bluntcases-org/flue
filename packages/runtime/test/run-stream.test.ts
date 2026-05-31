import { describe, expect, it, vi } from 'vitest';
import {
	createRunSubscriberRegistry,
	handleRunRouteRequest,
	InMemoryRunStore,
	type RunRecord,
	type RunStore,
	type RunSubscriberListener,
	type RunSubscriberRegistry,
} from '../src/internal.ts';
import type { FlueEvent } from '../src/types.ts';

const RUN_ID = 'workflow:trace:stream';
const OWNER = { kind: 'workflow' as const, workflowName: 'trace', instanceId: RUN_ID };

describe('workflow run SSE replay and tailing', () => {
	it('replays terminal history strictly after Last-Event-ID', async () => {
		const store = await createTerminalRun();

		const response = await streamResponse(store, undefined, { 'last-event-id': '1' });

		expect(await readSseIds(response)).toEqual([2]);
	});

	it('ignores malformed Last-Event-ID values', async () => {
		const store = await createTerminalRun();

		const response = await streamResponse(store, undefined, { 'last-event-id': '1garbage' });

		expect(await readSseIds(response)).toEqual([0, 1, 2]);
	});

	it('deduplicates replay overlap and then tails live events', async () => {
		const store = new DelayedFirstGetEventsRunStore();
		const subscribers = createRunSubscriberRegistry();
		await createActiveRun(store);
		const first = logEvent(0);
		await store.appendEvent(RUN_ID, first);
		const response = await streamResponse(store, subscribers);
		await store.firstReadStarted;

		subscribers.publish(RUN_ID, first);
		store.releaseFirstRead();
		await new Promise((resolve) => setTimeout(resolve, 0));
		subscribers.publish(RUN_ID, first);
		const second = logEvent(1);
		await store.appendEvent(RUN_ID, second);
		subscribers.publish(RUN_ID, second);
		const end = runEndEvent(2);
		await store.appendEvent(RUN_ID, end);
		subscribers.publish(RUN_ID, end);

		expect(await readSseIds(response)).toEqual([0, 1, 2]);
	});

	it('emits heartbeats and cleans up the subscriber when canceled', async () => {
		const store = new InMemoryRunStore();
		const subscribers = createTrackedRunSubscribers();
		let heartbeat: (() => void) | undefined;
		const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
			callback: () => void,
		) => {
			heartbeat = callback;
			return 1 as never;
		}) as typeof setInterval);
		const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
		await createActiveRun(store);
		const response = await streamResponse(store, subscribers.registry);
		const reader = response.body?.getReader();

		try {
			expect(subscribers.activeSubscriptions).toBe(1);
			heartbeat?.();
			const chunk = await reader?.read();
			expect(new TextDecoder().decode(chunk?.value)).toBe(': heartbeat\n\n');
			await reader?.cancel();
			expect(clear).toHaveBeenCalledWith(1);
			expect(subscribers.activeSubscriptions).toBe(0);
			expect(subscribers.unsubscribeCalls).toBe(1);
		} finally {
			await reader?.cancel();
			interval.mockRestore();
			clear.mockRestore();
		}
	});

	it('cleans up the subscriber when canceled during replay', async () => {
		const store = new DelayedFirstGetEventsRunStore();
		const subscribers = createTrackedRunSubscribers();
		await createActiveRun(store);
		const response = await streamResponse(store, subscribers.registry);
		await store.firstReadStarted;

		try {
			expect(subscribers.activeSubscriptions).toBe(1);
			await response.body?.cancel();
			expect(subscribers.activeSubscriptions).toBe(0);
			expect(subscribers.unsubscribeCalls).toBe(1);
		} finally {
			store.releaseFirstRead();
		}
	});

	it('cleans up after a stale terminal event is deduplicated', async () => {
		const store = new InMemoryRunStore();
		const subscribers = createTrackedRunSubscribers();
		const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1 as never);
		const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
		await createActiveRun(store);
		const response = await streamResponse(store, subscribers.registry, { 'last-event-id': '999' });
		await new Promise((resolve) => setTimeout(resolve, 0));

		try {
			expect(subscribers.activeSubscriptions).toBe(1);
			subscribers.registry.publish(RUN_ID, runEndEvent(0));
			expect(await response.text()).toBe('');
			expect(clear).toHaveBeenCalledWith(1);
			expect(subscribers.activeSubscriptions).toBe(0);
			expect(subscribers.unsubscribeCalls).toBe(1);
		} finally {
			interval.mockRestore();
			clear.mockRestore();
		}
	});

	it('cleans up after a buffered stale terminal event is deduplicated', async () => {
		const store = new DelayedFirstGetEventsRunStore();
		const subscribers = createTrackedRunSubscribers();
		await createActiveRun(store);
		const response = await streamResponse(store, subscribers.registry, { 'last-event-id': '999' });
		await store.firstReadStarted;

		subscribers.registry.publish(RUN_ID, runEndEvent(0));
		store.releaseFirstRead();

		expect(await response.text()).toBe('');
		expect(subscribers.activeSubscriptions).toBe(0);
		expect(subscribers.unsubscribeCalls).toBe(1);
	});

	it('refetches durable history after the replay buffer overflows', async () => {
		const store = new DelayedFirstGetEventsRunStore();
		const subscribers = createTrackedRunSubscribers();
		await createActiveRun(store);
		const response = await streamResponse(store, subscribers.registry);
		await store.firstReadStarted;

		for (let eventIndex = 0; eventIndex <= 1000; eventIndex++) {
			const event = logEvent(eventIndex);
			await store.appendEvent(RUN_ID, event);
			subscribers.registry.publish(RUN_ID, event);
		}
		const end = runEndEvent(1001);
		await store.appendEvent(RUN_ID, end);
		subscribers.registry.publish(RUN_ID, end);
		store.releaseFirstRead();

		expect(await readSseIds(response)).toEqual(Array.from({ length: 1002 }, (_, index) => index));
		expect(store.getEventsCalls).toEqual([undefined, undefined]);
		expect(subscribers.activeSubscriptions).toBe(0);
		expect(subscribers.unsubscribeCalls).toBe(1);
	});
});

async function createActiveRun(store: RunStore): Promise<void> {
	await store.createRun({
		runId: RUN_ID,
		owner: OWNER,
		startedAt: '2026-05-31T00:00:00.000Z',
		payload: {},
	});
}

async function createTerminalRun(): Promise<InMemoryRunStore> {
	const store = new InMemoryRunStore();
	await createActiveRun(store);
	await store.appendEvent(RUN_ID, logEvent(0));
	await store.appendEvent(RUN_ID, logEvent(1));
	await store.appendEvent(RUN_ID, runEndEvent(2));
	await store.endRun({
		runId: RUN_ID,
		endedAt: '2026-05-31T00:00:01.000Z',
		isError: false,
		durationMs: 1000,
		result: { ok: true },
	});
	return store;
}

function logEvent(eventIndex: number): FlueEvent {
	return {
		type: 'log',
		level: 'info',
		message: `event ${eventIndex}`,
		runId: RUN_ID,
		eventIndex,
		timestamp: '2026-05-31T00:00:00.000Z',
	};
}

function runEndEvent(eventIndex: number): FlueEvent {
	return {
		type: 'run_end',
		runId: RUN_ID,
		eventIndex,
		timestamp: '2026-05-31T00:00:01.000Z',
		result: { ok: true },
		isError: false,
		durationMs: 1000,
	};
}

function streamResponse(
	store: RunStore,
	subscribers?: RunSubscriberRegistry,
	headers?: HeadersInit,
): Promise<Response> {
	return handleRunRouteRequest({
		request: new Request(`http://localhost/runs/${RUN_ID}/stream`, { headers }),
		runStore: store,
		runSubscribers: subscribers,
		owner: OWNER,
		runId: RUN_ID,
		action: 'stream',
	});
}

async function readSseIds(response: Response): Promise<number[]> {
	const body = await response.text();
	return [...body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
}

class DelayedFirstGetEventsRunStore implements RunStore {
	private inner = new InMemoryRunStore();
	private resolveFirstReadStarted!: () => void;
	private resolveFirstRead!: () => void;
	private firstReadPending = true;
	readonly firstReadStarted = new Promise<void>((resolve) => {
		this.resolveFirstReadStarted = resolve;
	});
	private readonly firstReadReleased = new Promise<void>((resolve) => {
		this.resolveFirstRead = resolve;
	});
	readonly getEventsCalls: Array<number | undefined> = [];

	createRun(input: Parameters<RunStore['createRun']>[0]): Promise<void> {
		return this.inner.createRun(input);
	}

	endRun(input: Parameters<RunStore['endRun']>[0]): Promise<void> {
		return this.inner.endRun(input);
	}

	appendEvent(runId: string, event: FlueEvent): Promise<void> {
		return this.inner.appendEvent(runId, event);
	}

	async getEvents(runId: string, fromIndex?: number): Promise<FlueEvent[]> {
		this.getEventsCalls.push(fromIndex);
		const events = await this.inner.getEvents(runId, fromIndex);
		if (!this.firstReadPending) return events;
		this.firstReadPending = false;
		this.resolveFirstReadStarted();
		await this.firstReadReleased;
		return events;
	}

	getRun(runId: string): Promise<RunRecord | null> {
		return this.inner.getRun(runId);
	}

	releaseFirstRead(): void {
		this.resolveFirstRead();
	}
}

function createTrackedRunSubscribers(): {
	registry: RunSubscriberRegistry;
	readonly activeSubscriptions: number;
	readonly unsubscribeCalls: number;
} {
	const inner = createRunSubscriberRegistry();
	let activeSubscriptions = 0;
	let unsubscribeCalls = 0;
	return {
		registry: {
			subscribe(runId: string, listener: RunSubscriberListener) {
				activeSubscriptions++;
				const unsubscribe = inner.subscribe(runId, listener);
				let active = true;
				return () => {
					if (!active) return;
					active = false;
					activeSubscriptions--;
					unsubscribeCalls++;
					unsubscribe();
				};
			},
			publish(runId, event) {
				inner.publish(runId, event);
			},
			complete(runId) {
				inner.complete(runId);
			},
		},
		get activeSubscriptions() {
			return activeSubscriptions;
		},
		get unsubscribeCalls() {
			return unsubscribeCalls;
		},
	};
}
