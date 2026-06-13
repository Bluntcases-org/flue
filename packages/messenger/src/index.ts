import type { Context, Env, Handler } from 'hono';
import {
	InvalidMessengerConversationKeyError,
	InvalidMessengerInputError,
} from './errors.ts';
import {
	createMessengerVerificationHandler,
	createMessengerWebhookHandler,
} from './webhook.ts';

export {
	InvalidMessengerConversationKeyError,
	InvalidMessengerInputError,
} from './errors.ts';

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface ChannelRoute<E extends Env = Env> {
	readonly method: string;
	readonly path: string;
	readonly handler: Handler<E>;
}

/** Ingress configuration for one fixed Facebook Page. */
export interface MessengerChannelOptions<E extends Env = Env> {
	/** Meta app secret used to verify exact POST request bytes. */
	appSecret: string;
	/** User-chosen token configured for Meta's GET verification handshake. */
	verifyToken: string;
	/** Expected Facebook Page id from every accepted delivery. */
	pageId: string;
	/** Maximum POST body size in bytes. Defaults to 1 MiB. */
	bodyLimit?: number;
	/**
	 * Application handler deadline in milliseconds.
	 *
	 * Defaults to and may not exceed 4500, leaving time before Meta's
	 * five-second acknowledgement deadline.
	 */
	handlerTimeoutMs?: number;
	/** Receives one verified delivery with all batched events preserved. */
	webhook(input: MessengerWebhookHandlerInput<E>): MessengerHandlerResult;
}

export type MessengerParticipantRef =
	| { type: 'page-scoped-id'; id: string }
	| { type: 'user-ref'; id: string };

/** Stable Messenger destination suitable for a Flue agent-instance id. */
export interface MessengerConversationRef {
	pageId: string;
	participant: MessengerParticipantRef;
}

export interface MessengerReferral {
	ref?: string;
	source?: string;
	type?: string;
	adId?: string;
	refererUri?: string;
	adsContextData?: unknown;
	productId?: string;
}

export interface MessengerAttachment {
	type: string;
	url?: string;
	title?: string;
	stickerId?: number;
	/** Provider-native attachment payload after exact-body verification. */
	payload?: unknown;
}

export interface MessengerMessage {
	id: string;
	text?: string;
	attachments: readonly MessengerAttachment[];
	quickReplyPayload?: string;
	replyTo?: {
		messageId: string;
		isSelfReply?: boolean;
	};
	referral?: MessengerReferral;
	commands: readonly { name: string }[];
}

export interface MessengerEventPosition {
	pageId: string;
	entryTime: number;
	entryIndex: number;
	collection: 'messaging' | 'standby' | 'changes';
	itemIndex: number;
	timestamp?: number;
	/** Provider object for this event after exact-body verification. */
	raw: unknown;
}

export interface MessengerMessageEvent extends MessengerEventPosition {
	type: 'message';
	message: MessengerMessage;
	conversation: MessengerConversationRef;
}

export interface MessengerMessageEchoEvent extends MessengerEventPosition {
	type: 'message_echo';
	message: MessengerMessage;
	appId?: string;
	metadata?: string;
	conversation: MessengerConversationRef;
}

export interface MessengerMessageEditEvent extends MessengerEventPosition {
	type: 'message_edit';
	messageId: string;
	text: string;
	editCount: number;
	conversation: MessengerConversationRef;
}

export interface MessengerPostbackEvent extends MessengerEventPosition {
	type: 'postback';
	messageId?: string;
	title?: string;
	payload?: string;
	referral?: MessengerReferral;
	conversation: MessengerConversationRef;
}

export interface MessengerReactionEvent extends MessengerEventPosition {
	type: 'reaction';
	messageId: string;
	action: 'react' | 'unreact' | 'unknown';
	providerAction: string;
	reaction?: string;
	emoji?: string;
	conversation: MessengerConversationRef;
}

export interface MessengerDeliveryEvent extends MessengerEventPosition {
	type: 'delivery';
	messageIds: readonly string[];
	watermark: number;
	conversation: MessengerConversationRef;
}

export interface MessengerReadEvent extends MessengerEventPosition {
	type: 'read';
	watermark: number;
	conversation: MessengerConversationRef;
}

/**
 * Short-lived Messenger capabilities for trusted application use.
 *
 * Never place these values in model context, dispatch input, logs, or durable
 * session data.
 */
export interface MessengerOptInCapabilities {
	notificationMessagesToken?: string;
}

export interface MessengerOptInEvent extends MessengerEventPosition {
	type: 'optin';
	providerType?: string;
	ref?: string;
	payload?: string;
	title?: string;
	frequency?: string;
	timezone?: string;
	tokenExpiryTimestamp?: number;
	userTokenStatus?: string;
	notificationStatus?: string;
	capabilities?: MessengerOptInCapabilities;
	conversation: MessengerConversationRef;
}

export interface MessengerReferralEvent extends MessengerEventPosition {
	type: 'referral';
	referral: MessengerReferral;
	conversation: MessengerConversationRef;
}

export interface MessengerUnknownEvent extends MessengerEventPosition {
	type: 'unknown';
	eventType: string;
	conversation?: MessengerConversationRef;
}

export type MessengerWebhookEvent =
	| MessengerMessageEvent
	| MessengerMessageEchoEvent
	| MessengerMessageEditEvent
	| MessengerPostbackEvent
	| MessengerReactionEvent
	| MessengerDeliveryEvent
	| MessengerReadEvent
	| MessengerOptInEvent
	| MessengerReferralEvent
	| MessengerUnknownEvent;

export interface MessengerWebhookDelivery {
	object: 'page';
	/** Events remain in deterministic entry and provider-collection order. */
	events: readonly MessengerWebhookEvent[];
	/** Complete parsed payload after exact-body verification and identity checks. */
	raw: unknown;
}

type MessengerHandlerValue = undefined | JsonValue | Response;

export type MessengerHandlerResult =
	| MessengerHandlerValue
	| Promise<MessengerHandlerValue>;

export interface MessengerWebhookHandlerInput<E extends Env = Env> {
	c: Context<E>;
	delivery: MessengerWebhookDelivery;
}

/** Verified Facebook Messenger Page ingress and canonical identity helpers. */
export interface MessengerChannel<E extends Env = Env> {
	readonly routes: readonly ChannelRoute<E>[];
	/** Serializes a canonical namespaced identifier. It is not an authorization capability. */
	conversationKey(ref: MessengerConversationRef): string;
	/** Parses only canonical keys produced by `conversationKey()`. */
	parseConversationKey(id: string): MessengerConversationRef;
}

/**
 * Creates verified Facebook Messenger webhook routes for one fixed Page.
 *
 * The channel is stateless and does not deduplicate messages or deliveries.
 */
export function createMessengerChannel<E extends Env = Env>(
	options: MessengerChannelOptions<E>,
): MessengerChannel<E> {
	validateOptions(options);
	const channel: MessengerChannel<E> = {
		routes: [
			{
				method: 'GET',
				path: '/webhook',
				handler: createMessengerVerificationHandler(options),
			},
			{
				method: 'POST',
				path: '/webhook',
				handler: createMessengerWebhookHandler(options),
			},
		],
		conversationKey(ref) {
			assertConversationRef(ref);
			return [
				'messenger',
				'v1',
				'page',
				encodeURIComponent(ref.pageId),
				ref.participant.type,
				encodeURIComponent(ref.participant.id),
			].join(':');
		},
		parseConversationKey(id) {
			try {
				const match =
					/^messenger:v1:page:([^:]+):(page-scoped-id|user-ref):([^:]+)$/.exec(
						id,
					);
				if (!match) throw new InvalidMessengerConversationKeyError();
				const [, pageId, type, participantId] = match;
				if (!pageId || !type || !participantId) {
					throw new InvalidMessengerConversationKeyError();
				}
				const ref: MessengerConversationRef = {
					pageId: decodeURIComponent(pageId),
					participant: {
						type: type as MessengerParticipantRef['type'],
						id: decodeURIComponent(participantId),
					},
				};
				assertConversationRef(ref);
				if (channel.conversationKey(ref) !== id) {
					throw new InvalidMessengerConversationKeyError();
				}
				return ref;
			} catch (error) {
				if (error instanceof InvalidMessengerConversationKeyError) throw error;
				throw new InvalidMessengerConversationKeyError();
			}
		},
	};
	return channel;
}

function validateOptions<E extends Env>(
	options: MessengerChannelOptions<E>,
): void {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createMessengerChannel() requires an options object.');
	}
	assertSegment(options.appSecret, 'appSecret');
	assertSegment(options.verifyToken, 'verifyToken');
	assertSegment(options.pageId, 'pageId');
	if (typeof options.webhook !== 'function') {
		throw new InvalidMessengerInputError('webhook');
	}
}

function assertConversationRef(ref: MessengerConversationRef): void {
	if (!ref || typeof ref !== 'object') {
		throw new InvalidMessengerInputError('conversation');
	}
	assertSegment(ref.pageId, 'conversation.pageId');
	if (!ref.participant || typeof ref.participant !== 'object') {
		throw new InvalidMessengerInputError('conversation.participant');
	}
	if (
		ref.participant.type !== 'page-scoped-id' &&
		ref.participant.type !== 'user-ref'
	) {
		throw new InvalidMessengerInputError('conversation.participant.type');
	}
	assertSegment(ref.participant.id, 'conversation.participant.id');
}

function assertSegment(value: unknown, field: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new InvalidMessengerInputError(field);
	}
}
