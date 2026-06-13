import { Hono } from 'hono';
import twilio from 'twilio';
import { describe, expect, it, vi } from 'vitest';
import {
	createTwilioChannel,
	InvalidTwilioConversationKeyError,
	type InvalidTwilioInputError,
	type TwilioChannel,
	type TwilioConversationRef,
} from '../src/index.ts';

describe('createTwilioChannel()', () => {
	it('verifies and normalizes an MMS message when Twilio signs the configured URL', async () => {
		const webhook = vi.fn();
		const channel = createTwilioChannel({
			accountSid: 'AC11111111111111111111111111111111',
			authToken: 'auth-token-cobalt',
			webhookUrl:
				'https://hooks.example.test/public/messaging/inbound?environment=staging#rc=2&rp=all',
			destination: {
				type: 'messaging-service',
				messagingServiceSid: 'MG22222222222222222222222222222222',
			},
			webhook,
		});
		const params = new URLSearchParams([
			['MessageSid', 'MM33333333333333333333333333333333'],
			['AccountSid', 'AC11111111111111111111111111111111'],
			['MessagingServiceSid', 'MG22222222222222222222222222222222'],
			['From', '+15557001001'],
			['To', '+15557002002'],
			['Body', 'Inspect the loading dock.'],
			['NumMedia', '2'],
			['NumSegments', '1'],
			['MediaUrl0', 'https://api.twilio.test/media/ME-cobalt-0'],
			['MediaContentType0', 'image/webp'],
			['MediaUrl1', 'https://api.twilio.test/media/ME-cobalt-1'],
			['MediaContentType1', 'application/pdf'],
			['OptOutType', 'STOP'],
			['Latitude', '45.5231'],
			['Longitude', '-122.6765'],
			['FromCity', 'PORTLAND'],
			['FromState', 'OR'],
			['ButtonPayload', 'dock_north'],
			['ButtonText', 'North dock'],
			['InteractiveData', '{"type":"list-reply","id":"north"}'],
			['CustomTag', 'amber'],
			['CustomTag', 'violet'],
		]);
		const request = signedRequest({
			requestUrl:
				'https://internal.example.test/channels/twilio/webhook?environment=staging',
			signatureUrl:
				'https://hooks.example.test/public/messaging/inbound?environment=staging',
			authToken: 'auth-token-cobalt',
			params,
			headers: { 'i-twilio-idempotency-token': 'retry-token-cobalt' },
		});

		const result = await channelApp(channel).request(request);

		expect(result.status).toBe(200);
		expect(result.headers.get('content-type')).toBe('text/xml; charset=UTF-8');
		expect(await result.text()).toBe(
			'<?xml version="1.0" encoding="UTF-8"?><Response/>',
		);
		expect(webhook).toHaveBeenCalledOnce();
		expect(webhook.mock.calls[0]?.[0]).toMatchObject({
			c: expect.any(Object),
			message: {
				sid: 'MM33333333333333333333333333333333',
				accountSid: 'AC11111111111111111111111111111111',
				from: '+15557001001',
				to: '+15557002002',
				body: 'Inspect the loading dock.',
				numSegments: 1,
				messagingServiceSid: 'MG22222222222222222222222222222222',
				media: [
					{
						index: 0,
						url: 'https://api.twilio.test/media/ME-cobalt-0',
						contentType: 'image/webp',
					},
					{
						index: 1,
						url: 'https://api.twilio.test/media/ME-cobalt-1',
						contentType: 'application/pdf',
					},
				],
				optOut: { type: 'stop', providerType: 'STOP' },
				location: {
					latitude: 45.5231,
					longitude: -122.6765,
					fromCity: 'PORTLAND',
					fromState: 'OR',
				},
				rich: {
					buttonPayload: 'dock_north',
					buttonText: 'North dock',
					interactiveData: '{"type":"list-reply","id":"north"}',
				},
				idempotencyToken: 'retry-token-cobalt',
				conversation: {
					type: 'messaging-service',
					accountSid: 'AC11111111111111111111111111111111',
					messagingServiceSid: 'MG22222222222222222222222222222222',
					address: '+15557002002',
					participant: '+15557001001',
				},
				raw: {
					CustomTag: ['amber', 'violet'],
				},
			},
		});
	});

	it('publishes and normalizes the optional status callback when configured', async () => {
		const webhook = vi.fn();
		const statusCallback = vi.fn();
		const channel = createTwilioChannel({
			accountSid: 'AC44444444444444444444444444444444',
			authToken: 'auth-token-maple',
			webhookUrl: 'https://hooks.example.test/channels/twilio/webhook',
			statusCallbackUrl: 'https://hooks.example.test/channels/twilio/status',
			destination: {
				type: 'messaging-service',
				messagingServiceSid: 'MG44444444444444444444444444444444',
			},
			webhook,
			statusCallback,
		});
		const params = new URLSearchParams([
			['MessageSid', 'SM55555555555555555555555555555555'],
			['AccountSid', 'AC44444444444444444444444444444444'],
			['MessageStatus', 'carrier-confirmed'],
			['From', '+15557003003'],
			['To', '+15557004004'],
			['ErrorCode', '30007'],
			['ErrorMessage', 'Synthetic carrier rejection'],
			['ChannelStatusMessage', 'Undelivered by synthetic carrier'],
			['RawDlrDoneDate', '2606131836'],
		]);

		const result = await channelApp(channel).request(
			signedRequest({
				requestUrl: 'https://edge.example.test/channels/twilio/status',
				signatureUrl: 'https://hooks.example.test/channels/twilio/status',
				authToken: 'auth-token-maple',
				params,
				headers: { 'i-twilio-idempotency-token': 'retry-token-maple' },
			}),
		);

		expect(channel.routes.map((route) => route.path)).toEqual([
			'/webhook',
			'/status',
		]);
		expect(result.status).toBe(200);
		expect(await result.text()).toBe('');
		expect(webhook).not.toHaveBeenCalled();
		expect(statusCallback).toHaveBeenCalledOnce();
		expect(statusCallback.mock.calls[0]?.[0]).toMatchObject({
			status: {
				messageSid: 'SM55555555555555555555555555555555',
				accountSid: 'AC44444444444444444444444444444444',
				state: 'unknown',
				providerState: 'carrier-confirmed',
				from: '+15557003003',
				to: '+15557004004',
				errorCode: 30007,
				errorMessage: 'Synthetic carrier rejection',
				channelStatusMessage: 'Undelivered by synthetic carrier',
				rawDlrDoneDate: '2606131836',
				idempotencyToken: 'retry-token-maple',
				conversation: {
					type: 'messaging-service',
					accountSid: 'AC44444444444444444444444444444444',
					messagingServiceSid: 'MG44444444444444444444444444444444',
					address: '+15557003003',
					participant: '+15557004004',
				},
			},
		});

		const wrongService = new URLSearchParams(params);
		wrongService.set(
			'MessagingServiceSid',
			'MG99999999999999999999999999999999',
		);
		const rejected = await channelApp(channel).request(
			signedRequest({
				requestUrl: 'https://edge.example.test/channels/twilio/status',
				signatureUrl: 'https://hooks.example.test/channels/twilio/status',
				authToken: 'auth-token-maple',
				params: wrongService,
			}),
		);
		expect(rejected.status).toBe(403);
		expect(statusCallback).toHaveBeenCalledOnce();
	});

	it('passes through an ordinary response from the application handler', async () => {
		const webhook = vi.fn(({ c }) =>
			c.body('<Response><Message>Queued.</Message></Response>', 202, {
				'content-type': 'text/xml',
			}),
		);
		const channel = createTwilioChannel({
			accountSid: 'AC66666666666666666666666666666666',
			authToken: 'auth-token-cedar',
			webhookUrl: 'https://hooks.example.test/channels/twilio/webhook',
			destination: { type: 'address', address: '+15557005005' },
			webhook,
		});
		const params = baseMessageParams({
			accountSid: 'AC66666666666666666666666666666666',
			messageSid: 'SM77777777777777777777777777777777',
			from: '+15557006006',
			to: '+15557005005',
			body: 'Queue this task.',
		});
		params.set(
			'MessagingServiceSid',
			'MGffffffffffffffffffffffffffffffff',
		);

		const result = await channelApp(channel).request(
			signedRequest({
				requestUrl: 'https://hooks.example.test/channels/twilio/webhook',
				signatureUrl: 'https://hooks.example.test/channels/twilio/webhook',
				authToken: 'auth-token-cedar',
				params,
			}),
		);

		expect(result.status).toBe(202);
		expect(result.headers.get('content-type')).toBe('text/xml');
		expect(await result.text()).toBe(
			'<Response><Message>Queued.</Message></Response>',
		);
		expect(webhook.mock.calls[0]?.[0].message.conversation).toEqual({
			type: 'address',
			accountSid: 'AC66666666666666666666666666666666',
			address: '+15557005005',
			participant: '+15557006006',
		});
	});

	it('rejects invalid signatures, changed paths, identities, and known duplicate fields', async () => {
		const webhook = vi.fn();
		const channel = createTwilioChannel({
			accountSid: 'AC88888888888888888888888888888888',
			authToken: 'auth-token-elm',
			webhookUrl: 'https://hooks.example.test/channels/twilio/webhook',
			destination: { type: 'address', address: '+15557007007' },
			webhook,
		});
		const valid = baseMessageParams({
			accountSid: 'AC88888888888888888888888888888888',
			messageSid: 'SM99999999999999999999999999999999',
			from: '+15557008008',
			to: '+15557007007',
			body: 'Original body',
		});
		const changed = new URLSearchParams(valid);
		changed.set('Body', 'Changed body');
		const wrongIdentity = new URLSearchParams(valid);
		wrongIdentity.set('To', '+15557009999');
		const duplicated = new URLSearchParams(valid);
		duplicated.append('MessageSid', 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

		const app = channelApp(channel);
		const invalidSignature = await app.request(
			new Request('https://hooks.example.test/channels/twilio/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					'x-twilio-signature': twilio.getExpectedTwilioSignature(
						'auth-token-elm',
						'https://hooks.example.test/channels/twilio/webhook',
						toTwilioParams(valid),
					),
				},
				body: changed,
			}),
		);
		const changedQuery = await app.request(
			signedRequest({
				requestUrl:
					'https://hooks.example.test/channels/twilio/webhook?added=true',
				signatureUrl: 'https://hooks.example.test/channels/twilio/webhook',
				authToken: 'auth-token-elm',
				params: valid,
			}),
		);
		const rejectedIdentity = await app.request(
			signedRequest({
				requestUrl: 'https://hooks.example.test/channels/twilio/webhook',
				signatureUrl: 'https://hooks.example.test/channels/twilio/webhook',
				authToken: 'auth-token-elm',
				params: wrongIdentity,
			}),
		);
		const duplicateKnownField = await app.request(
			signedRequest({
				requestUrl: 'https://hooks.example.test/channels/twilio/webhook',
				signatureUrl: 'https://hooks.example.test/channels/twilio/webhook',
				authToken: 'auth-token-elm',
				params: duplicated,
			}),
		);

		expect(invalidSignature.status).toBe(401);
		expect(changedQuery.status).toBe(400);
		expect(rejectedIdentity.status).toBe(403);
		expect(duplicateKnownField.status).toBe(400);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('rejects unsupported content, oversized forms, malformed fields, and handler failures', async () => {
		const webhook = vi.fn().mockRejectedValue(new Error('synthetic failure'));
		const channel = createTwilioChannel({
			accountSid: 'ACbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			authToken: 'auth-token-fir',
			webhookUrl: 'https://hooks.example.test/channels/twilio/webhook',
			destination: { type: 'address', address: '+15557009009' },
			bodyLimit: 512,
			webhook,
		});
		const valid = baseMessageParams({
			accountSid: 'ACbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			messageSid: 'SMcccccccccccccccccccccccccccccccc',
			from: '+15557010010',
			to: '+15557009009',
			body: 'Fail in the handler.',
		});
		const malformed = new URLSearchParams(valid);
		malformed.set('NumMedia', 'not-a-number');

		const app = channelApp(channel);
		const unsupported = await app.request(
			'https://hooks.example.test/channels/twilio/webhook',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}',
			},
		);
		const oversized = await app.request(
			'https://hooks.example.test/channels/twilio/webhook',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					'content-length': '513',
				},
				body: 'Body=x',
			},
		);
		const malformedResult = await app.request(
			signedRequest({
				requestUrl: 'https://hooks.example.test/channels/twilio/webhook',
				signatureUrl: 'https://hooks.example.test/channels/twilio/webhook',
				authToken: 'auth-token-fir',
				params: malformed,
			}),
		);
		const failed = await app.request(
			signedRequest({
				requestUrl: 'https://hooks.example.test/channels/twilio/webhook',
				signatureUrl: 'https://hooks.example.test/channels/twilio/webhook',
				authToken: 'auth-token-fir',
				params: valid,
			}),
		);

		expect(unsupported.status).toBe(415);
		expect(oversized.status).toBe(413);
		expect(malformedResult.status).toBe(400);
		expect(failed.status).toBe(500);
		expect(webhook).toHaveBeenCalledOnce();
	});

	it('round-trips canonical address and Messaging Service conversation keys', () => {
		const channel = createTwilioChannel({
			accountSid: 'ACdddddddddddddddddddddddddddddddd',
			authToken: 'auth-token-juniper',
			webhookUrl: 'https://hooks.example.test/channels/twilio/webhook',
			destination: { type: 'address', address: '+15557011011' },
			webhook() {},
		});
		const refs: TwilioConversationRef[] = [
			{
				type: 'address',
				accountSid: 'ACdddddddddddddddddddddddddddddddd',
				address: 'whatsapp:+15557011011',
				participant: 'whatsapp:+15557012012',
			},
			{
				type: 'messaging-service',
				accountSid: 'ACdddddddddddddddddddddddddddddddd',
				messagingServiceSid: 'MGeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
				address: '+15557011011',
				participant: '+15557012012',
			},
		];

		for (const ref of refs) {
			const id = channel.conversationKey(ref);
			expect(channel.parseConversationKey(id)).toEqual(ref);
		}
		expect(() =>
			channel.parseConversationKey(
				'twilio:v1:account:ACbad:address:%2B1555:participant:%2b1666',
			),
		).toThrow(InvalidTwilioConversationKeyError);
	});

	it('validates required options and status callback pairs', () => {
		expect(() =>
			createTwilioChannel({
				accountSid: '',
				authToken: 'token',
				webhookUrl: 'https://hooks.example.test/channels/twilio/webhook',
				destination: { type: 'address', address: '+15557013013' },
				webhook() {},
			}),
		).toThrowError(
			expect.objectContaining<Partial<InvalidTwilioInputError>>({
				field: 'accountSid',
			}),
		);
		expect(() =>
			createTwilioChannel({
				accountSid: 'ACffffffffffffffffffffffffffffffff',
				authToken: 'token',
				webhookUrl: 'https://hooks.example.test/channels/twilio/webhook',
				statusCallbackUrl:
					'https://hooks.example.test/channels/twilio/status',
				destination: { type: 'address', address: '+15557013013' },
				webhook() {},
			}),
		).toThrowError(
			expect.objectContaining<Partial<InvalidTwilioInputError>>({
				field: 'statusCallback',
			}),
		);
		expect(() =>
			createTwilioChannel({
				accountSid: 'ACffffffffffffffffffffffffffffffff',
				authToken: 'token',
				webhookUrl: '/relative',
				destination: { type: 'address', address: '+15557013013' },
				webhook() {},
			}),
		).toThrowError(
			expect.objectContaining<Partial<InvalidTwilioInputError>>({
				field: 'webhookUrl',
			}),
		);
	});
});

function channelApp(channel: TwilioChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) {
		app.on(route.method, `/channels/twilio${route.path}`, route.handler);
	}
	return app;
}

function baseMessageParams(input: {
	accountSid: string;
	messageSid: string;
	from: string;
	to: string;
	body: string;
}): URLSearchParams {
	return new URLSearchParams([
		['MessageSid', input.messageSid],
		['AccountSid', input.accountSid],
		['From', input.from],
		['To', input.to],
		['Body', input.body],
		['NumMedia', '0'],
		['NumSegments', '1'],
	]);
}

function signedRequest(input: {
	requestUrl: string;
	signatureUrl: string;
	authToken: string;
	params: URLSearchParams;
	headers?: Record<string, string>;
}): Request {
	const signature = twilio.getExpectedTwilioSignature(
		input.authToken,
		input.signatureUrl,
		toTwilioParams(input.params),
	);
	return new Request(input.requestUrl, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			'x-twilio-signature': signature,
			...input.headers,
		},
		body: input.params,
	});
}

function toTwilioParams(
	params: URLSearchParams,
): Record<string, string | string[]> {
	const result: Record<string, string | string[]> = {};
	for (const [name, value] of params) {
		const existing = result[name];
		if (existing === undefined) {
			result[name] = value;
		} else if (Array.isArray(existing)) {
			existing.push(value);
		} else {
			result[name] = [existing, value];
		}
	}
	return result;
}
