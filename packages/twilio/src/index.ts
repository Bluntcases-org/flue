import type { Context, Env, Handler } from 'hono';
import {
	InvalidTwilioConversationKeyError,
	InvalidTwilioInputError,
} from './errors.ts';
import {
	createTwilioStatusCallbackHandler,
	createTwilioWebhookHandler,
} from './webhook.ts';

export {
	InvalidTwilioConversationKeyError,
	InvalidTwilioInputError,
} from './errors.ts';

export interface ChannelRoute<E extends Env = Env> {
	readonly method: string;
	readonly path: string;
	readonly handler: Handler<E>;
}

/** Fixed Twilio identity accepted by one channel. */
export type TwilioDestination =
	| {
			type: 'address';
			address: string;
	  }
	| {
			type: 'messaging-service';
			messagingServiceSid: string;
	  };

/** Ingress configuration for one Twilio account and messaging destination. */
export interface TwilioChannelOptions<E extends Env = Env> {
	/** Account SID required in every accepted message and status callback. */
	accountSid: string;
	/** Auth token used to validate the `X-Twilio-Signature` header. */
	authToken: string;
	/**
	 * Exact externally configured inbound webhook URL.
	 *
	 * Twilio signs this public URL, so it cannot be reconstructed reliably from
	 * a request after a reverse proxy. Connection-override fragments are allowed
	 * and excluded from signature validation as Twilio specifies.
	 */
	webhookUrl: string;
	/** Fixed phone/channel address or Messaging Service accepted by the channel. */
	destination: TwilioDestination;
	/** Maximum form body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/** Receives one verified inbound SMS or MMS message. */
	webhook(input: TwilioWebhookHandlerInput<E>): TwilioHandlerResult;
	/**
	 * Exact externally configured delivery-status callback URL.
	 *
	 * Required together with `statusCallback`.
	 */
	statusCallbackUrl?: string;
	/**
	 * Receives one verified outbound message status callback.
	 *
	 * Omitting this callback leaves `/status` unpublished.
	 */
	statusCallback?(input: TwilioStatusHandlerInput<E>): TwilioHandlerResult;
}

/** Provider form fields preserved after signature verification. */
export type TwilioFormParameters = Readonly<
	Record<string, string | readonly string[]>
>;

/** Stable Twilio destination suitable for a Flue agent-instance id. */
export type TwilioConversationRef =
	| {
			type: 'address';
			accountSid: string;
			address: string;
			participant: string;
	  }
	| {
			type: 'messaging-service';
			accountSid: string;
			messagingServiceSid: string;
			address: string;
			participant: string;
	  };

export interface TwilioMedia {
	index: number;
	/** Authenticated Twilio media URL. Credentials are not embedded in it. */
	url: string;
	contentType: string;
}

export interface TwilioOptOut {
	type: 'start' | 'stop' | 'help' | 'unknown';
	providerType: string;
}

export interface TwilioLocation {
	latitude?: number;
	longitude?: number;
	fromCity?: string;
	fromState?: string;
	fromZip?: string;
	fromCountry?: string;
	toCity?: string;
	toState?: string;
	toZip?: string;
	toCountry?: string;
}

export interface TwilioRichMessageMetadata {
	buttonPayload?: string;
	buttonText?: string;
	originalRepliedMessageSender?: string;
	originalRepliedMessageSid?: string;
	referralNumMedia?: number;
	referralMediaContentType?: string;
	referralMediaUrl?: string;
	referralBody?: string;
	referralHeadline?: string;
	channelMetadata?: string;
	interactiveData?: string;
	flowData?: string;
}

export interface TwilioIncomingMessage {
	sid: string;
	accountSid: string;
	from: string;
	to: string;
	body: string;
	numSegments: number;
	messagingServiceSid?: string;
	media: readonly TwilioMedia[];
	optOut?: TwilioOptOut;
	location?: TwilioLocation;
	rich?: TwilioRichMessageMetadata;
	/** Retry identity supplied by Twilio's webhook transport when present. */
	idempotencyToken?: string;
	conversation: TwilioConversationRef;
	/** Complete signed form fields. */
	raw: TwilioFormParameters;
}

export type TwilioMessageState =
	| 'accepted'
	| 'scheduled'
	| 'queued'
	| 'sending'
	| 'sent'
	| 'delivered'
	| 'undelivered'
	| 'failed'
	| 'read'
	| 'canceled'
	| 'receiving'
	| 'received'
	| 'unknown';

export interface TwilioMessageStatus {
	messageSid: string;
	accountSid: string;
	state: TwilioMessageState;
	/** Exact `MessageStatus` value from Twilio. */
	providerState: string;
	from?: string;
	to?: string;
	messagingServiceSid?: string;
	errorCode?: number;
	errorMessage?: string;
	channelStatusMessage?: string;
	rawDlrDoneDate?: string;
	/** Retry identity supplied by Twilio's webhook transport when present. */
	idempotencyToken?: string;
	/** Present when sender and participant addresses are available. */
	conversation?: TwilioConversationRef;
	/** Complete signed form fields. */
	raw: TwilioFormParameters;
}

type TwilioHandlerValue = undefined | Response;

export type TwilioHandlerResult =
	| TwilioHandlerValue
	| Promise<TwilioHandlerValue>;

export interface TwilioWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	message: TwilioIncomingMessage;
}

export interface TwilioStatusHandlerInput<E extends Env = Env> {
	c: Context<E>;
	status: TwilioMessageStatus;
}

/** Verified Twilio Messaging ingress and canonical identity helpers. */
export interface TwilioChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
	/** Serializes a canonical namespaced identifier. It is not an authorization capability. */
	conversationKey(ref: TwilioConversationRef): string;
	/** Parses only canonical keys produced by `conversationKey()`. */
	parseConversationKey(id: string): TwilioConversationRef;
}

/**
 * Creates verified Twilio Messaging webhook routes for one fixed destination.
 *
 * The channel is stateless and does not deduplicate message SIDs or retry
 * tokens.
 */
export function createTwilioChannel<E extends Env = Env>(
	options: TwilioChannelOptions<E>,
): TwilioChannel<E> {
	validateOptions(options);
	const routes: ChannelRoute<E>[] = [
		{
			method: 'POST',
			path: '/webhook',
			handler: createTwilioWebhookHandler(options),
		},
	];
	if (options.statusCallback && options.statusCallbackUrl) {
		routes.push({
			method: 'POST',
			path: '/status',
			handler: createTwilioStatusCallbackHandler(options),
		});
	}

	const channel: TwilioChannel<E> = {
		routes,
		conversationKey(ref) {
			assertConversationRef(ref);
			const base = [
				'twilio',
				'v1',
				'account',
				encodeURIComponent(ref.accountSid),
			];
			return ref.type === 'address'
				? [
						...base,
						'address',
						encodeURIComponent(ref.address),
						'participant',
						encodeURIComponent(ref.participant),
					].join(':')
				: [
						...base,
						'messaging-service',
						encodeURIComponent(ref.messagingServiceSid),
						'address',
						encodeURIComponent(ref.address),
						'participant',
						encodeURIComponent(ref.participant),
					].join(':');
		},
		parseConversationKey(id) {
			try {
				const address =
					/^twilio:v1:account:([^:]+):address:([^:]+):participant:([^:]+)$/.exec(
						id,
					);
				const service =
					/^twilio:v1:account:([^:]+):messaging-service:([^:]+):address:([^:]+):participant:([^:]+)$/.exec(
						id,
					);
				let ref: TwilioConversationRef;
				if (address) {
					const [, accountSid, destination, participant] = address;
					if (!accountSid || !destination || !participant) {
						throw new InvalidTwilioConversationKeyError();
					}
					ref = {
						type: 'address',
						accountSid: decodeURIComponent(accountSid),
						address: decodeURIComponent(destination),
						participant: decodeURIComponent(participant),
					};
				} else if (service) {
					const [, accountSid, messagingServiceSid, destination, participant] =
						service;
					if (!accountSid || !messagingServiceSid || !destination || !participant) {
						throw new InvalidTwilioConversationKeyError();
					}
					ref = {
						type: 'messaging-service',
						accountSid: decodeURIComponent(accountSid),
						messagingServiceSid: decodeURIComponent(messagingServiceSid),
						address: decodeURIComponent(destination),
						participant: decodeURIComponent(participant),
					};
				} else {
					throw new InvalidTwilioConversationKeyError();
				}
				assertConversationRef(ref);
				if (channel.conversationKey(ref) !== id) {
					throw new InvalidTwilioConversationKeyError();
				}
				return ref;
			} catch (error) {
				if (error instanceof InvalidTwilioConversationKeyError) throw error;
				throw new InvalidTwilioConversationKeyError();
			}
		},
	};
	return channel;
}

function validateOptions<E extends Env>(options: TwilioChannelOptions<E>): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createTwilioChannel() requires an options object.');
	}
	assertSegment(options.accountSid, 'accountSid');
	assertSegment(options.authToken, 'authToken');
	assertConfiguredUrl(options.webhookUrl, 'webhookUrl');
	if (!options.destination || typeof options.destination !== 'object') {
		throw new InvalidTwilioInputError('destination');
	}
	if (options.destination.type === 'address') {
		assertSegment(options.destination.address, 'destination.address');
	} else if (options.destination.type === 'messaging-service') {
		assertSegment(
			options.destination.messagingServiceSid,
			'destination.messagingServiceSid',
		);
	} else {
		throw new InvalidTwilioInputError('destination.type');
	}
	if (typeof options.webhook !== 'function') {
		throw new InvalidTwilioInputError('webhook');
	}
	const hasStatusUrl = options.statusCallbackUrl !== undefined;
	const hasStatusHandler = options.statusCallback !== undefined;
	if (hasStatusUrl !== hasStatusHandler) {
		throw new InvalidTwilioInputError(
			hasStatusUrl ? 'statusCallback' : 'statusCallbackUrl',
		);
	}
	if (options.statusCallbackUrl !== undefined) {
		assertConfiguredUrl(options.statusCallbackUrl, 'statusCallbackUrl');
	}
	if (
		options.statusCallback !== undefined &&
		typeof options.statusCallback !== 'function'
	) {
		throw new InvalidTwilioInputError('statusCallback');
	}
}

function assertConfiguredUrl(value: unknown, field: string): asserts value is string {
	assertSegment(value, field);
	try {
		const parsed = new URL(value);
		if (
			(parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
			!parsed.hostname ||
			parsed.username ||
			parsed.password
		) {
			throw new InvalidTwilioInputError(field);
		}
	} catch (error) {
		if (error instanceof InvalidTwilioInputError) throw error;
		throw new InvalidTwilioInputError(field);
	}
}

function assertConversationRef(ref: TwilioConversationRef): void {
	if (!ref || typeof ref !== 'object') throw new InvalidTwilioInputError('ref');
	assertSegment(ref.accountSid, 'conversation.accountSid');
	assertSegment(ref.address, 'conversation.address');
	assertSegment(ref.participant, 'conversation.participant');
	if (ref.type === 'address') return;
	if (ref.type === 'messaging-service') {
		assertSegment(
			ref.messagingServiceSid,
			'conversation.messagingServiceSid',
		);
		return;
	}
	throw new InvalidTwilioInputError('conversation.type');
}

function assertSegment(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new InvalidTwilioInputError(field);
	}
}
