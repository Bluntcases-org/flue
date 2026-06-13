import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
	createMessengerChannel,
	InvalidMessengerConversationKeyError,
	type InvalidMessengerInputError,
	type MessengerChannel,
	type MessengerConversationRef,
} from '../src/index.ts';

describe('createMessengerChannel()', () => {
	it('answers one valid verification challenge and rejects invalid query shapes', async () => {
		const channel = createMessengerChannel({
			appSecret: 'app-secret-copper',
			verifyToken: 'verify-token-copper',
			pageId: 'page_copper_41',
			webhook() {},
		});
		const app = channelApp(channel);

		const accepted = await app.request(
			'https://hooks.example.test/channels/messenger/webhook?hub.mode=subscribe&hub.challenge=challenge-copper&hub.verify_token=verify-token-copper',
		);
		const wrongToken = await app.request(
			'https://hooks.example.test/channels/messenger/webhook?hub.mode=subscribe&hub.challenge=challenge-copper&hub.verify_token=wrong-token',
		);
		const duplicate = await app.request(
			'https://hooks.example.test/channels/messenger/webhook?hub.mode=subscribe&hub.challenge=challenge-copper&hub.verify_token=verify-token-copper&hub.verify_token=verify-token-copper',
		);

		expect(accepted.status).toBe(200);
		expect(accepted.headers.get('content-type')).toBe(
			'text/plain; charset=UTF-8',
		);
		expect(await accepted.text()).toBe('challenge-copper');
		expect(wrongToken.status).toBe(403);
		expect(duplicate.status).toBe(400);
	});

	it('verifies and preserves one ordered batch of messages, edits, reactions, and unknown events', async () => {
		const webhook = vi.fn();
		const channel = createMessengerChannel({
			appSecret: 'app-secret-amber',
			verifyToken: 'verify-token-amber',
			pageId: 'page_amber_42',
			webhook,
		});
		const body = JSON.stringify({
			object: 'page',
			entry: [
				{
					id: 'page_amber_42',
					time: 1_781_350_000_001,
					messaging: [
						{
							sender: { id: 'psid_amber_43' },
							recipient: { id: 'page_amber_42' },
							timestamp: 1_781_350_000_002,
							message: {
								mid: 'm_amber_message_44',
								text: 'Inspect the west loading bay.',
								quick_reply: { payload: 'bay-west' },
								reply_to: {
									mid: 'm_amber_parent_45',
									is_self_reply: false,
								},
								attachments: [
									{
										type: 'sticker',
										payload: {
											url: 'https://cdn.example.test/sticker-amber.webp',
											sticker_id: 4601,
										},
									},
								],
								commands: [{ name: 'inspect' }],
							},
						},
						{
							sender: { id: 'psid_amber_43' },
							recipient: { id: 'page_amber_42' },
							timestamp: 1_781_350_000_003,
							message_edit: {
								mid: 'm_amber_message_44',
								text: 'Inspect the west loading bay first.',
								num_edit: 1,
							},
						},
						{
							sender: { id: 'psid_amber_43' },
							recipient: { id: 'page_amber_42' },
							timestamp: 1_781_350_000_004,
							reaction: {
								mid: 'm_amber_reply_46',
								action: 'react',
								reaction: 'other',
								emoji: '🟧',
							},
						},
						{
							sender: { id: 'psid_amber_43' },
							recipient: { id: 'page_amber_42' },
							timestamp: 1_781_350_000_005,
							future_signal: { color: 'amber' },
						},
					],
				},
			],
		});

		const result = await channelApp(channel).request(
			await signedRequest(body, 'app-secret-amber'),
		);

		expect(result.status).toBe(200);
		expect(result.headers.get('content-type')).toBe(
			'text/plain; charset=UTF-8',
		);
		expect(await result.text()).toBe('EVENT_RECEIVED');
		expect(webhook).toHaveBeenCalledOnce();
		const delivery = webhook.mock.calls[0]?.[0].delivery;
		expect(delivery.events.map((event: { type: string }) => event.type)).toEqual([
			'message',
			'message_edit',
			'reaction',
			'unknown',
		]);
		expect(delivery.events[0]).toMatchObject({
			type: 'message',
			entryIndex: 0,
			collection: 'messaging',
			itemIndex: 0,
			message: {
				id: 'm_amber_message_44',
				text: 'Inspect the west loading bay.',
				quickReplyPayload: 'bay-west',
				replyTo: {
					messageId: 'm_amber_parent_45',
					isSelfReply: false,
				},
				attachments: [
					{
						type: 'sticker',
						url: 'https://cdn.example.test/sticker-amber.webp',
						stickerId: 4601,
					},
				],
				commands: [{ name: 'inspect' }],
			},
			conversation: {
				pageId: 'page_amber_42',
				participant: {
					type: 'page-scoped-id',
					id: 'psid_amber_43',
				},
			},
		});
		expect(delivery.events[1]).toMatchObject({
			type: 'message_edit',
			messageId: 'm_amber_message_44',
			text: 'Inspect the west loading bay first.',
			editCount: 1,
		});
		expect(delivery.events[2]).toMatchObject({
			type: 'reaction',
			messageId: 'm_amber_reply_46',
			action: 'react',
			providerAction: 'react',
			reaction: 'other',
			emoji: '🟧',
		});
		expect(delivery.events[3]).toMatchObject({
			type: 'unknown',
			eventType: 'future_signal',
		});
	});

	it('normalizes current change-shaped postbacks, opt-in capabilities, and referrals', async () => {
		const webhook = vi.fn();
		const channel = createMessengerChannel({
			appSecret: 'app-secret-violet',
			verifyToken: 'verify-token-violet',
			pageId: 'page_violet_47',
			webhook,
		});
		const body = JSON.stringify({
			object: 'page',
			entry: [
				{
					id: 'page_violet_47',
					time: 1_781_350_100_001,
					changes: [
						{
							field: 'messaging_postbacks',
							value: {
								sender: { user_ref: 'user_ref_violet_48' },
								recipient: { id: 'page_violet_47' },
								timestamp: '1781350100002',
								postback: {
									mid: 'm_violet_postback_49',
									title: 'Open violet queue',
									payload: 'queue-violet',
									referral: {
										ref: 'violet-ref',
										source: 'SHORTLINK',
										type: 'OPEN_THREAD',
									},
								},
							},
						},
						{
							field: 'messaging_optins',
							value: {
								sender: { id: 'psid_violet_50' },
								recipient: { id: 'page_violet_47' },
								timestamp: '1781350100003',
								optin: {
									type: 'notification_messages',
									payload: 'shipment-violet',
									title: 'Shipment updates',
									notification_messages_frequency: 'WEEKLY',
									notification_messages_timezone: 'America/Denver',
									notification_messages_token: 'capability-violet',
									token_expiry_timestamp: '1789126100',
									user_token_status: 'NOT_REFRESHED',
								},
							},
						},
						{
							field: 'messaging_referrals',
							value: {
								sender: { id: 'psid_violet_50' },
								recipient: { id: 'page_violet_47' },
								timestamp: 1_781_350_100_004,
								referral: {
									ref: 'ad-violet',
									source: 'ADS',
									type: 'OPEN_THREAD',
									ad_id: 5102,
									ads_context_data: {
										ad_title: 'Violet inventory',
									},
								},
							},
						},
					],
				},
			],
		});

		const result = await channelApp(channel).request(
			await signedRequest(body, 'app-secret-violet'),
		);

		expect(result.status).toBe(200);
		const events = webhook.mock.calls[0]?.[0].delivery.events;
		expect(events).toHaveLength(3);
		expect(events[0]).toMatchObject({
			type: 'postback',
			messageId: 'm_violet_postback_49',
			title: 'Open violet queue',
			payload: 'queue-violet',
			conversation: {
				pageId: 'page_violet_47',
				participant: {
					type: 'user-ref',
					id: 'user_ref_violet_48',
				},
			},
		});
		expect(events[1]).toMatchObject({
			type: 'optin',
			providerType: 'notification_messages',
			payload: 'shipment-violet',
			frequency: 'WEEKLY',
			timezone: 'America/Denver',
			tokenExpiryTimestamp: 1_789_126_100,
			capabilities: {
				notificationMessagesToken: 'capability-violet',
			},
		});
		expect(events[2]).toMatchObject({
			type: 'referral',
			referral: {
				ref: 'ad-violet',
				source: 'ADS',
				type: 'OPEN_THREAD',
				adId: '5102',
			},
		});
	});

	it('normalizes echoes, deliveries, reads, and standby without dispatching standby semantics', async () => {
		const webhook = vi.fn();
		const channel = createMessengerChannel({
			appSecret: 'app-secret-maple',
			verifyToken: 'verify-token-maple',
			pageId: 'page_maple_51',
			webhook,
		});
		const body = JSON.stringify({
			object: 'page',
			entry: [
				{
					id: 'page_maple_51',
					time: 1_781_350_200_001,
					messaging: [
						{
							sender: { id: 'page_maple_51' },
							recipient: { id: 'psid_maple_52' },
							timestamp: 1_781_350_200_002,
							message: {
								mid: 'm_maple_echo_53',
								is_echo: true,
								app_id: 5401,
								metadata: 'maple-metadata',
								text: 'Maple response',
							},
						},
						{
							sender: { id: 'psid_maple_52' },
							recipient: { id: 'page_maple_51' },
							delivery: {
								mids: ['m_maple_echo_53'],
								watermark: 1_781_350_200_003,
							},
						},
						{
							sender: { id: 'psid_maple_52' },
							recipient: { id: 'page_maple_51' },
							timestamp: 1_781_350_200_004,
							read: { watermark: 1_781_350_200_003 },
						},
					],
					standby: [
						{
							sender: { id: 'psid_maple_52' },
							recipient: { id: 'page_maple_51' },
							timestamp: 1_781_350_200_005,
							message: {
								mid: 'm_maple_standby_54',
								text: 'Owned by another app',
							},
						},
					],
				},
			],
		});

		const result = await channelApp(channel).request(
			await signedRequest(body, 'app-secret-maple'),
		);

		expect(result.status).toBe(200);
		const events = webhook.mock.calls[0]?.[0].delivery.events;
		expect(events.map((event: { type: string }) => event.type)).toEqual([
			'message_echo',
			'delivery',
			'read',
			'unknown',
		]);
		expect(events[0]).toMatchObject({
			type: 'message_echo',
			appId: '5401',
			metadata: 'maple-metadata',
			conversation: {
				participant: {
					type: 'page-scoped-id',
					id: 'psid_maple_52',
				},
			},
		});
		expect(events[1]).toMatchObject({
			type: 'delivery',
			messageIds: ['m_maple_echo_53'],
			watermark: 1_781_350_200_003,
		});
		expect(events[2]).toMatchObject({
			type: 'read',
			watermark: 1_781_350_200_003,
		});
		expect(events[3]).toMatchObject({
			type: 'unknown',
			eventType: 'standby',
			collection: 'standby',
		});
	});

	it('rejects changed signatures, wrong Page identity, malformed known events, and oversized bodies', async () => {
		const webhook = vi.fn();
		const channel = createMessengerChannel({
			appSecret: 'app-secret-cedar',
			verifyToken: 'verify-token-cedar',
			pageId: 'page_cedar_55',
			bodyLimit: 700,
			webhook,
		});
		const valid = JSON.stringify({
			object: 'page',
			entry: [
				{
					id: 'page_cedar_55',
					time: 1_781_350_300_001,
					messaging: [
						{
							sender: { id: 'psid_cedar_56' },
							recipient: { id: 'page_cedar_55' },
							timestamp: 1_781_350_300_002,
							message: {
								mid: 'm_cedar_57',
								text: 'Cedar résumé',
							},
						},
					],
				},
			],
		});
		const changed = valid.replace('résumé', 'resume');
		const invalidSignature = new Request(
			'https://hooks.example.test/channels/messenger/webhook',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-hub-signature-256': await signature(
						valid,
						'app-secret-cedar',
					),
				},
				body: changed,
			},
		);
		const wrongPageBody = valid.replaceAll('page_cedar_55', 'page_other_58');
		const malformedBody = valid.replace('"mid":"m_cedar_57",', '');
		const app = channelApp(channel);

		const changedResult = await app.request(invalidSignature);
		const wrongPage = await app.request(
			await signedRequest(wrongPageBody, 'app-secret-cedar'),
		);
		const malformed = await app.request(
			await signedRequest(malformedBody, 'app-secret-cedar'),
		);
		const unsupported = await app.request(
			'https://hooks.example.test/channels/messenger/webhook',
			{
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: valid,
			},
		);
		const oversized = await app.request(
			'https://hooks.example.test/channels/messenger/webhook',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': '701',
					'x-hub-signature-256': await signature(
						valid,
						'app-secret-cedar',
					),
				},
				body: valid,
			},
		);

		expect(changedResult.status).toBe(401);
		expect(wrongPage.status).toBe(403);
		expect(malformed.status).toBe(400);
		expect(unsupported.status).toBe(415);
		expect(oversized.status).toBe(413);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('passes through JSON and Response values and fails closed on handler timeout', async () => {
		const base = {
			object: 'page',
			entry: [
				{
					id: 'page_fir_59',
					time: 1_781_350_400_001,
					messaging: [
						{
							sender: { id: 'psid_fir_60' },
							recipient: { id: 'page_fir_59' },
							timestamp: 1_781_350_400_002,
							message: {
								mid: 'm_fir_61',
								text: 'Response control',
							},
						},
					],
				},
			],
		};
		const jsonChannel = createMessengerChannel({
			appSecret: 'app-secret-fir',
			verifyToken: 'verify-token-fir',
			pageId: 'page_fir_59',
			webhook() {
				return { received: true };
			},
		});
		const responseChannel = createMessengerChannel({
			appSecret: 'app-secret-fir',
			verifyToken: 'verify-token-fir',
			pageId: 'page_fir_59',
			webhook({ c }) {
				return c.text('custom-fir', 202);
			},
		});
		const timeoutChannel = createMessengerChannel({
			appSecret: 'app-secret-fir',
			verifyToken: 'verify-token-fir',
			pageId: 'page_fir_59',
			handlerTimeoutMs: 5,
			webhook() {
				return new Promise(() => {});
			},
		});
		const body = JSON.stringify(base);

		const json = await channelApp(jsonChannel).request(
			await signedRequest(body, 'app-secret-fir'),
		);
		const custom = await channelApp(responseChannel).request(
			await signedRequest(body, 'app-secret-fir'),
		);
		const timeout = await channelApp(timeoutChannel).request(
			await signedRequest(body, 'app-secret-fir'),
		);

		expect(json.status).toBe(200);
		expect(await json.json()).toEqual({ received: true });
		expect(custom.status).toBe(202);
		expect(await custom.text()).toBe('custom-fir');
		expect(timeout.status).toBe(500);
	});

	it('round-trips canonical participant keys and validates constructor options', () => {
		const channel = createMessengerChannel({
			appSecret: 'app-secret-oak',
			verifyToken: 'verify-token-oak',
			pageId: 'page_oak_62',
			webhook() {},
		});
		const refs: MessengerConversationRef[] = [
			{
				pageId: 'page_oak_62',
				participant: {
					type: 'page-scoped-id',
					id: 'psid:oak/63',
				},
			},
			{
				pageId: 'page_oak_62',
				participant: {
					type: 'user-ref',
					id: 'user ref oak 64',
				},
			},
		];
		for (const ref of refs) {
			const id = channel.conversationKey(ref);
			expect(channel.parseConversationKey(id)).toEqual(ref);
		}
		expect(() =>
			channel.parseConversationKey(
				'messenger:v1:page:page_oak_62:page-scoped-id:%70sid',
			),
		).toThrow(InvalidMessengerConversationKeyError);
		expect(() =>
			createMessengerChannel({
				appSecret: '',
				verifyToken: 'verify-token-oak',
				pageId: 'page_oak_62',
				webhook() {},
			}),
		).toThrowError(
			expect.objectContaining<Partial<InvalidMessengerInputError>>({
				field: 'appSecret',
			}),
		);
		expect(() =>
			createMessengerChannel({
				appSecret: 'app-secret-oak',
				verifyToken: 'verify-token-oak',
				pageId: 'page_oak_62',
				handlerTimeoutMs: 4_501,
				webhook() {},
			}),
		).toThrow(TypeError);
	});
});

function channelApp(channel: MessengerChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) {
		app.on(route.method, `/channels/messenger${route.path}`, route.handler);
	}
	return app;
}

async function signedRequest(body: string, appSecret: string): Promise<Request> {
	return new Request('https://hooks.example.test/channels/messenger/webhook', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-hub-signature-256': await signature(body, appSecret),
		},
		body,
	});
}

async function signature(body: string, appSecret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(appSecret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const bytes = new Uint8Array(
		await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
	);
	return `sha256=${[...bytes]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')}`;
}
