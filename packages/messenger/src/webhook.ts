import type { Env, Handler } from 'hono';
import type {
	JsonValue,
	MessengerAttachment,
	MessengerChannelOptions,
	MessengerConversationRef,
	MessengerDeliveryEvent,
	MessengerEventPosition,
	MessengerMessage,
	MessengerOptInEvent,
	MessengerParticipantRef,
	MessengerReferral,
	MessengerWebhookDelivery,
	MessengerWebhookEvent,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_HANDLER_TIMEOUT_MS = 4_500;
const EVENT_RECEIVED = 'EVENT_RECEIVED';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createMessengerVerificationHandler<E extends Env>(
	options: MessengerChannelOptions<E>,
): Handler<E> {
	const expectedTokenDigest = digest(options.verifyToken);
	return async (c) => {
		const url = new URL(c.req.url);
		const mode = readSingleQuery(url, 'hub.mode');
		const challenge = readSingleQuery(url, 'hub.challenge');
		const token = readSingleQuery(url, 'hub.verify_token');
		if (mode === undefined || challenge === undefined || token === undefined) {
			return response(400);
		}
		if (mode !== 'subscribe' || challenge.length === 0) return response(400);
		if (!(await secureEqual(await expectedTokenDigest, await digest(token)))) {
			return response(403);
		}
		return new Response(challenge, {
			status: 200,
			headers: { 'content-type': 'text/plain; charset=UTF-8' },
		});
	};
}

export function createMessengerWebhookHandler<E extends Env>(
	options: MessengerChannelOptions<E>,
): Handler<E> {
	const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
	const handlerTimeoutMs =
		options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Messenger webhook bodyLimit must be a positive integer.');
	}
	if (
		!Number.isSafeInteger(handlerTimeoutMs) ||
		handlerTimeoutMs <= 0 ||
		handlerTimeoutMs > DEFAULT_HANDLER_TIMEOUT_MS
	) {
		throw new TypeError(
			'Messenger webhook handlerTimeoutMs must be between 1 and 4500.',
		);
	}
	const key = importSigningKey(options.appSecret);

	return async (c) => {
		const request = c.req.raw;
		if (!isJsonRequest(request)) return response(415);
		const signature = parseSignature(
			request.headers.get('x-hub-signature-256'),
		);
		if (!signature) return response(401);

		const body = await readBody(request, bodyLimit);
		if (body.type === 'too-large') return response(413);
		if (body.type === 'invalid') return response(400);
		if (!(await verifySignature(await key, body.value, signature))) {
			return response(401);
		}

		const raw = parseJson(body.value);
		if (!isRecord(raw)) return response(400);
		const normalized = normalizeDelivery(raw, options.pageId);
		if (normalized.type === 'forbidden') return response(403);
		if (normalized.type === 'invalid') return response(400);

		const outcome = await runHandler(
			() => options.webhook({ c, delivery: normalized.delivery }),
			handlerTimeoutMs,
		);
		if (outcome.type !== 'success') return response(500);
		return serializeHandlerResult(outcome.value);
	};
}

type NormalizedDelivery =
	| { type: 'ok'; delivery: MessengerWebhookDelivery }
	| { type: 'forbidden' }
	| { type: 'invalid' };

function normalizeDelivery(
	raw: Record<string, unknown>,
	pageId: string,
): NormalizedDelivery {
	if (raw.object !== 'page' || !Array.isArray(raw.entry)) {
		return { type: 'invalid' };
	}
	const events: MessengerWebhookEvent[] = [];
	for (let entryIndex = 0; entryIndex < raw.entry.length; entryIndex += 1) {
		const entry = raw.entry[entryIndex];
		if (!isRecord(entry)) return { type: 'invalid' };
		const entryPageId = readNonEmptyString(entry, 'id');
		const entryTime = readIntegerLike(entry, 'time');
		if (!entryPageId || entryTime === undefined) return { type: 'invalid' };
		if (entryPageId !== pageId) return { type: 'forbidden' };

		let hasCollection = false;
		for (const collection of ['messaging', 'standby'] as const) {
			const value = entry[collection];
			if (value === undefined) continue;
			hasCollection = true;
			if (!Array.isArray(value)) return { type: 'invalid' };
			for (let itemIndex = 0; itemIndex < value.length; itemIndex += 1) {
				const eventRaw = value[itemIndex];
				if (!isRecord(eventRaw)) return { type: 'invalid' };
				const position = eventPosition(
					pageId,
					entryTime,
					entryIndex,
					collection,
					itemIndex,
					eventRaw,
				);
				if (!position) return { type: 'invalid' };
				if (collection === 'standby') {
					const unknown = normalizeUnknownEvent(
						eventRaw,
						position,
						'standby',
						pageId,
					);
					if (unknown.type !== 'ok') return unknown;
					events.push(unknown.event);
					continue;
				}
				const event = normalizeEvent(eventRaw, position, pageId);
				if (event.type !== 'ok') return event;
				events.push(event.event);
			}
		}

		const changes = entry.changes;
		if (changes !== undefined) {
			hasCollection = true;
			if (!Array.isArray(changes)) return { type: 'invalid' };
			for (let itemIndex = 0; itemIndex < changes.length; itemIndex += 1) {
				const change = changes[itemIndex];
				if (!isRecord(change)) return { type: 'invalid' };
				const field = readNonEmptyString(change, 'field');
				const value = readRecord(change, 'value');
				if (!field || !value) return { type: 'invalid' };
				const position = eventPosition(
					pageId,
					entryTime,
					entryIndex,
					'changes',
					itemIndex,
					change,
					value,
				);
				if (!position) return { type: 'invalid' };
				const event = normalizeEvent(value, position, pageId, field);
				if (event.type !== 'ok') return event;
				events.push(event.event);
			}
		}
		if (!hasCollection) return { type: 'invalid' };
	}
	return {
		type: 'ok',
		delivery: {
			object: 'page',
			events,
			raw,
		},
	};
}

type NormalizedEvent =
	| { type: 'ok'; event: MessengerWebhookEvent }
	| { type: 'forbidden' }
	| { type: 'invalid' };

function normalizeEvent(
	raw: Record<string, unknown>,
	position: MessengerEventPosition,
	pageId: string,
	forcedType?: string,
): NormalizedEvent {
	const eventType = forcedType ?? detectEventType(raw);
	switch (eventType) {
		case 'messages':
		case 'message':
			return normalizeMessageEvent(raw, position, pageId, false);
		case 'message_echoes':
			return normalizeMessageEvent(raw, position, pageId, true);
		case 'message_edits':
		case 'message_edit':
			return normalizeMessageEditEvent(raw, position, pageId);
		case 'messaging_postbacks':
		case 'postback':
			return normalizePostbackEvent(raw, position, pageId);
		case 'message_reactions':
		case 'reaction':
			return normalizeReactionEvent(raw, position, pageId);
		case 'message_deliveries':
		case 'delivery':
			return normalizeDeliveryEvent(raw, position, pageId);
		case 'message_reads':
		case 'read':
			return normalizeReadEvent(raw, position, pageId);
		case 'messaging_optins':
		case 'optin':
			return normalizeOptInEvent(raw, position, pageId);
		case 'messaging_referrals':
		case 'referral':
			return normalizeReferralEvent(raw, position, pageId);
		default:
			return normalizeUnknownEvent(raw, position, eventType, pageId);
	}
}

function normalizeMessageEvent(
	raw: Record<string, unknown>,
	position: MessengerEventPosition,
	pageId: string,
	forceEcho: boolean,
): NormalizedEvent {
	const messageRaw = readRecord(raw, 'message');
	if (!messageRaw) return { type: 'invalid' };
	const isEcho = forceEcho || messageRaw.is_echo === true;
	const identity = conversationFromEvent(raw, pageId);
	if (identity.type !== 'ok') return identity;
	if (isEcho && identity.direction !== 'outbound') return { type: 'forbidden' };
	if (!isEcho && identity.direction !== 'inbound') return { type: 'forbidden' };
	const message = normalizeMessage(messageRaw);
	if (!message) return { type: 'invalid' };
	if (!isEcho) {
		return {
			type: 'ok',
			event: {
				...position,
				type: 'message',
				message,
				conversation: identity.conversation,
			},
		};
	}
	const appId = readStringOrNumber(messageRaw, 'app_id');
	const metadata = readOptionalString(messageRaw, 'metadata');
	if (
		(messageRaw.app_id !== undefined && appId === undefined) ||
		(messageRaw.metadata !== undefined && metadata === undefined)
	) {
		return { type: 'invalid' };
	}
	return {
		type: 'ok',
		event: {
			...position,
			type: 'message_echo',
			message,
			...(appId === undefined ? {} : { appId }),
			...(metadata === undefined ? {} : { metadata }),
			conversation: identity.conversation,
		},
	};
}

function normalizeMessageEditEvent(
	raw: Record<string, unknown>,
	position: MessengerEventPosition,
	pageId: string,
): NormalizedEvent {
	const identity = conversationFromEvent(raw, pageId);
	if (identity.type !== 'ok') return identity;
	if (identity.direction !== 'inbound') return { type: 'forbidden' };
	const edit = readRecord(raw, 'message_edit') ?? raw;
	const messageId = readNonEmptyString(edit, 'mid');
	const text = readString(edit, 'text');
	const editCount = readIntegerLike(edit, 'num_edit');
	if (!messageId || text === undefined || editCount === undefined) {
		return { type: 'invalid' };
	}
	return {
		type: 'ok',
		event: {
			...position,
			type: 'message_edit',
			messageId,
			text,
			editCount,
			conversation: identity.conversation,
		},
	};
}

function normalizePostbackEvent(
	raw: Record<string, unknown>,
	position: MessengerEventPosition,
	pageId: string,
): NormalizedEvent {
	const identity = conversationFromEvent(raw, pageId);
	if (identity.type !== 'ok') return identity;
	if (identity.direction !== 'inbound') return { type: 'forbidden' };
	const postback = readRecord(raw, 'postback') ?? raw;
	const messageId = readOptionalString(postback, 'mid');
	const title = readOptionalString(postback, 'title');
	const payload = readOptionalString(postback, 'payload');
	const referral = normalizeReferral(postback.referral);
	if (
		(postback.mid !== undefined && messageId === undefined) ||
		(postback.title !== undefined && title === undefined) ||
		(postback.payload !== undefined && payload === undefined) ||
		referral === null ||
		(messageId === undefined && title === undefined && payload === undefined)
	) {
		return { type: 'invalid' };
	}
	return {
		type: 'ok',
		event: {
			...position,
			type: 'postback',
			...(messageId === undefined ? {} : { messageId }),
			...(title === undefined ? {} : { title }),
			...(payload === undefined ? {} : { payload }),
			...(referral === undefined ? {} : { referral }),
			conversation: identity.conversation,
		},
	};
}

function normalizeReactionEvent(
	raw: Record<string, unknown>,
	position: MessengerEventPosition,
	pageId: string,
): NormalizedEvent {
	const identity = conversationFromEvent(raw, pageId);
	if (identity.type !== 'ok') return identity;
	if (identity.direction !== 'inbound') return { type: 'forbidden' };
	const reactionRaw = readRecord(raw, 'reaction') ?? raw;
	const messageId = readNonEmptyString(reactionRaw, 'mid');
	const providerAction = readNonEmptyString(reactionRaw, 'action');
	const reaction = readOptionalString(reactionRaw, 'reaction');
	const emoji = readOptionalString(reactionRaw, 'emoji');
	if (
		!messageId ||
		!providerAction ||
		(reactionRaw.reaction !== undefined && reaction === undefined) ||
		(reactionRaw.emoji !== undefined && emoji === undefined)
	) {
		return { type: 'invalid' };
	}
	return {
		type: 'ok',
		event: {
			...position,
			type: 'reaction',
			messageId,
			action:
				providerAction === 'react' || providerAction === 'unreact'
					? providerAction
					: 'unknown',
			providerAction,
			...(reaction === undefined ? {} : { reaction }),
			...(emoji === undefined ? {} : { emoji }),
			conversation: identity.conversation,
		},
	};
}

function normalizeDeliveryEvent(
	raw: Record<string, unknown>,
	position: MessengerEventPosition,
	pageId: string,
): NormalizedEvent {
	const identity = conversationFromEvent(raw, pageId);
	if (identity.type !== 'ok') return identity;
	if (identity.direction !== 'inbound') return { type: 'forbidden' };
	const delivery = readRecord(raw, 'delivery') ?? raw;
	const watermark = readSafeInteger(delivery, 'watermark');
	const messageIds = normalizeStringArray(delivery.mids);
	if (
		watermark === undefined ||
		(delivery.mids !== undefined && messageIds === undefined)
	) {
		return { type: 'invalid' };
	}
	const event: MessengerDeliveryEvent = {
		...position,
		type: 'delivery',
		messageIds: messageIds ?? [],
		watermark,
		conversation: identity.conversation,
	};
	return { type: 'ok', event };
}

function normalizeReadEvent(
	raw: Record<string, unknown>,
	position: MessengerEventPosition,
	pageId: string,
): NormalizedEvent {
	const identity = conversationFromEvent(raw, pageId);
	if (identity.type !== 'ok') return identity;
	if (identity.direction !== 'inbound') return { type: 'forbidden' };
	const read = readRecord(raw, 'read') ?? raw;
	const watermark = readSafeInteger(read, 'watermark');
	if (watermark === undefined) return { type: 'invalid' };
	return {
		type: 'ok',
		event: {
			...position,
			type: 'read',
			watermark,
			conversation: identity.conversation,
		},
	};
}

function normalizeOptInEvent(
	raw: Record<string, unknown>,
	position: MessengerEventPosition,
	pageId: string,
): NormalizedEvent {
	const identity = conversationFromEvent(raw, pageId);
	if (identity.type !== 'ok') return identity;
	if (identity.direction !== 'inbound') return { type: 'forbidden' };
	const optin = readRecord(raw, 'optin') ?? raw;
	const providerType = readOptionalString(optin, 'type');
	const ref = readOptionalString(optin, 'ref');
	const payload = readOptionalString(optin, 'payload');
	const title = readOptionalString(optin, 'title');
	const frequency = readOptionalString(
		optin,
		'notification_messages_frequency',
	);
	const timezone = readOptionalString(
		optin,
		'notification_messages_timezone',
	);
	const userTokenStatus = readOptionalString(optin, 'user_token_status');
	const notificationStatus = readOptionalString(
		optin,
		'notification_messages_status',
	);
	const notificationMessagesToken = readOptionalString(
		optin,
		'notification_messages_token',
	);
	const tokenExpiryTimestamp = readIntegerLike(
		optin,
		'token_expiry_timestamp',
	);
	if (
		hasInvalidOptionalString(optin, 'type', providerType) ||
		hasInvalidOptionalString(optin, 'ref', ref) ||
		hasInvalidOptionalString(optin, 'payload', payload) ||
		hasInvalidOptionalString(optin, 'title', title) ||
		hasInvalidOptionalString(
			optin,
			'notification_messages_frequency',
			frequency,
		) ||
		hasInvalidOptionalString(
			optin,
			'notification_messages_timezone',
			timezone,
		) ||
		hasInvalidOptionalString(optin, 'user_token_status', userTokenStatus) ||
		hasInvalidOptionalString(
			optin,
			'notification_messages_status',
			notificationStatus,
		) ||
		hasInvalidOptionalString(
			optin,
			'notification_messages_token',
			notificationMessagesToken,
		) ||
		(optin.token_expiry_timestamp !== undefined &&
			tokenExpiryTimestamp === undefined)
	) {
		return { type: 'invalid' };
	}
	const event: MessengerOptInEvent = {
		...position,
		type: 'optin',
		...(providerType === undefined ? {} : { providerType }),
		...(ref === undefined ? {} : { ref }),
		...(payload === undefined ? {} : { payload }),
		...(title === undefined ? {} : { title }),
		...(frequency === undefined ? {} : { frequency }),
		...(timezone === undefined ? {} : { timezone }),
		...(tokenExpiryTimestamp === undefined ? {} : { tokenExpiryTimestamp }),
		...(userTokenStatus === undefined ? {} : { userTokenStatus }),
		...(notificationStatus === undefined ? {} : { notificationStatus }),
		...(notificationMessagesToken === undefined
			? {}
			: { capabilities: { notificationMessagesToken } }),
		conversation: identity.conversation,
	};
	return { type: 'ok', event };
}

function normalizeReferralEvent(
	raw: Record<string, unknown>,
	position: MessengerEventPosition,
	pageId: string,
): NormalizedEvent {
	const identity = conversationFromEvent(raw, pageId);
	if (identity.type !== 'ok') return identity;
	if (identity.direction !== 'inbound') return { type: 'forbidden' };
	const referral = normalizeReferral(raw.referral ?? raw);
	if (!referral) return { type: 'invalid' };
	return {
		type: 'ok',
		event: {
			...position,
			type: 'referral',
			referral,
			conversation: identity.conversation,
		},
	};
}

function normalizeUnknownEvent(
	raw: Record<string, unknown>,
	position: MessengerEventPosition,
	eventType: string,
	pageId: string,
): NormalizedEvent {
	const identity = conversationFromEvent(raw, pageId, true);
	if (identity.type === 'forbidden' || identity.type === 'invalid') {
		return identity;
	}
	return {
		type: 'ok',
		event: {
			...position,
			type: 'unknown',
			eventType,
			...(identity.type === 'ok'
				? { conversation: identity.conversation }
				: {}),
		},
	};
}

function normalizeMessage(raw: Record<string, unknown>): MessengerMessage | undefined {
	const id = readNonEmptyString(raw, 'mid');
	if (!id) return undefined;
	const text = readOptionalString(raw, 'text');
	if (raw.text !== undefined && text === undefined) return undefined;
	const attachments = normalizeAttachments(raw.attachments);
	if (raw.attachments !== undefined && attachments === undefined) return undefined;
	const quickReply = readRecord(raw, 'quick_reply');
	const quickReplyPayload = quickReply
		? readOptionalString(quickReply, 'payload')
		: undefined;
	if (
		quickReply &&
		quickReply.payload !== undefined &&
		quickReplyPayload === undefined
	) {
		return undefined;
	}
	const replyToRaw = readRecord(raw, 'reply_to');
	const replyMessageId = replyToRaw
		? readNonEmptyString(replyToRaw, 'mid')
		: undefined;
	if (replyToRaw && !replyMessageId) return undefined;
	const isSelfReply = replyToRaw?.is_self_reply;
	if (isSelfReply !== undefined && typeof isSelfReply !== 'boolean') {
		return undefined;
	}
	const referral = normalizeReferral(raw.referral);
	if (referral === null) return undefined;
	const commands = normalizeCommands(raw.commands);
	if (raw.commands !== undefined && commands === undefined) return undefined;
	return {
		id,
		...(text === undefined ? {} : { text }),
		attachments: attachments ?? [],
		...(quickReplyPayload === undefined ? {} : { quickReplyPayload }),
		...(replyMessageId === undefined
			? {}
			: {
					replyTo: {
						messageId: replyMessageId,
						...(typeof isSelfReply === 'boolean' ? { isSelfReply } : {}),
					},
				}),
		...(referral === undefined ? {} : { referral }),
		commands: commands ?? [],
	};
}

function normalizeAttachments(
	value: unknown,
): readonly MessengerAttachment[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return undefined;
	const attachments: MessengerAttachment[] = [];
	for (const item of value) {
		if (!isRecord(item)) return undefined;
		const type = readNonEmptyString(item, 'type');
		if (!type) return undefined;
		const payload = item.payload;
		const payloadRecord = isRecord(payload) ? payload : undefined;
		const url = payloadRecord
			? readOptionalString(payloadRecord, 'url')
			: undefined;
		const title = readOptionalString(item, 'title');
		const stickerId = payloadRecord
			? readSafeInteger(payloadRecord, 'sticker_id')
			: undefined;
		if (
			(payloadRecord?.url !== undefined && url === undefined) ||
			(item.title !== undefined && title === undefined) ||
			(payloadRecord?.sticker_id !== undefined && stickerId === undefined)
		) {
			return undefined;
		}
		attachments.push({
			type,
			...(url === undefined ? {} : { url }),
			...(title === undefined ? {} : { title }),
			...(stickerId === undefined ? {} : { stickerId }),
			...(payload === undefined ? {} : { payload }),
		});
	}
	return attachments;
}

function normalizeCommands(
	value: unknown,
): readonly { name: string }[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return undefined;
	const commands: { name: string }[] = [];
	for (const item of value) {
		if (!isRecord(item)) return undefined;
		const name = readNonEmptyString(item, 'name');
		if (!name) return undefined;
		commands.push({ name });
	}
	return commands;
}

function normalizeReferral(
	value: unknown,
): MessengerReferral | undefined | null {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return null;
	const ref = readOptionalString(value, 'ref');
	const source = readOptionalString(value, 'source');
	const type = readOptionalString(value, 'type');
	const adId = readStringOrNumber(value, 'ad_id');
	const refererUri = readOptionalString(value, 'referer_uri');
	const product = readRecord(value, 'product');
	const productId = product ? readStringOrNumber(product, 'id') : undefined;
	if (
		hasInvalidOptionalString(value, 'ref', ref) ||
		hasInvalidOptionalString(value, 'source', source) ||
		hasInvalidOptionalString(value, 'type', type) ||
		(value.ad_id !== undefined && adId === undefined) ||
		hasInvalidOptionalString(value, 'referer_uri', refererUri) ||
		(product?.id !== undefined && productId === undefined)
	) {
		return null;
	}
	if (
		ref === undefined &&
		source === undefined &&
		type === undefined &&
		adId === undefined &&
		refererUri === undefined &&
		productId === undefined &&
		value.ads_context_data === undefined
	) {
		return null;
	}
	return {
		...(ref === undefined ? {} : { ref }),
		...(source === undefined ? {} : { source }),
		...(type === undefined ? {} : { type }),
		...(adId === undefined ? {} : { adId }),
		...(refererUri === undefined ? {} : { refererUri }),
		...(value.ads_context_data === undefined
			? {}
			: { adsContextData: value.ads_context_data }),
		...(productId === undefined ? {} : { productId }),
	};
}

function eventPosition(
	pageId: string,
	entryTime: number,
	entryIndex: number,
	collection: MessengerEventPosition['collection'],
	itemIndex: number,
	raw: Record<string, unknown>,
	timestampSource: Record<string, unknown> = raw,
): MessengerEventPosition | undefined {
	const timestamp = readIntegerLike(timestampSource, 'timestamp');
	if (
		timestampSource.timestamp !== undefined &&
		timestamp === undefined
	) {
		return undefined;
	}
	return {
		pageId,
		entryTime,
		entryIndex,
		collection,
		itemIndex,
		...(timestamp === undefined ? {} : { timestamp }),
		raw,
	};
}

type ConversationResult =
	| {
			type: 'ok';
			conversation: MessengerConversationRef;
			direction: 'inbound' | 'outbound';
	  }
	| { type: 'absent' }
	| { type: 'forbidden' }
	| { type: 'invalid' };

function conversationFromEvent(
	raw: Record<string, unknown>,
	pageId: string,
): Exclude<ConversationResult, { type: 'absent' }>;
function conversationFromEvent(
	raw: Record<string, unknown>,
	pageId: string,
	allowAbsent: true,
): ConversationResult;
function conversationFromEvent(
	raw: Record<string, unknown>,
	pageId: string,
	allowAbsent = false,
): ConversationResult {
	const senderRaw = readRecord(raw, 'sender');
	const recipientRaw = readRecord(raw, 'recipient');
	if (!senderRaw && !recipientRaw) {
		return allowAbsent ? { type: 'absent' } : { type: 'invalid' };
	}
	if (!senderRaw || !recipientRaw) return { type: 'invalid' };
	const sender = normalizeActor(senderRaw, pageId);
	const recipient = normalizeActor(recipientRaw, pageId);
	if (!sender || !recipient) return { type: 'invalid' };
	if (sender.type === 'page' && sender.id === pageId && recipient.type !== 'page') {
		return {
			type: 'ok',
			direction: 'outbound',
			conversation: {
				pageId,
				participant: recipient,
			},
		};
	}
	if (
		recipient.type === 'page' &&
		recipient.id === pageId &&
		sender.type !== 'page'
	) {
		return {
			type: 'ok',
			direction: 'inbound',
			conversation: {
				pageId,
				participant: sender,
			},
		};
	}
	if (
		(sender.type === 'page' && sender.id !== pageId) ||
		(recipient.type === 'page' && recipient.id !== pageId) ||
		(sender.type === 'page' && recipient.type === 'page')
	) {
		return { type: 'forbidden' };
	}
	return { type: 'forbidden' };
}

type MessengerActor =
	| { type: 'page'; id: string }
	| MessengerParticipantRef;

function normalizeActor(
	raw: Record<string, unknown>,
	pageId: string,
): MessengerActor | undefined {
	const id = readOptionalString(raw, 'id');
	const userRef = readOptionalString(raw, 'user_ref');
	if (
		(raw.id !== undefined && id === undefined) ||
		(raw.user_ref !== undefined && userRef === undefined) ||
		(id !== undefined && userRef !== undefined)
	) {
		return undefined;
	}
	if (id !== undefined) {
		return id === pageId
			? { type: 'page', id }
			: { type: 'page-scoped-id', id };
	}
	if (userRef !== undefined) return { type: 'user-ref', id: userRef };
	return undefined;
}

function detectEventType(raw: Record<string, unknown>): string {
	if (raw.message !== undefined) return 'message';
	if (raw.message_edit !== undefined) return 'message_edit';
	if (raw.postback !== undefined) return 'postback';
	if (raw.reaction !== undefined) return 'reaction';
	if (raw.delivery !== undefined) return 'delivery';
	if (raw.read !== undefined) return 'read';
	if (raw.optin !== undefined) return 'optin';
	if (raw.referral !== undefined) return 'referral';
	return (
		Object.keys(raw).find(
			(key) => key !== 'sender' && key !== 'recipient' && key !== 'timestamp',
		) ?? 'unknown'
	);
}

function isJsonRequest(request: Request): boolean {
	return (
		request.headers
			.get('content-type')
			?.split(';', 1)[0]
			?.trim()
			.toLowerCase() === 'application/json'
	);
}

async function readBody(
	request: Request,
	bodyLimit: number,
): Promise<
	| { type: 'ok'; value: Uint8Array }
	| { type: 'too-large' }
	| { type: 'invalid' }
> {
	const contentLength = request.headers.get('content-length');
	if (contentLength) {
		const length = Number(contentLength);
		if (Number.isFinite(length) && length > bodyLimit) {
			return { type: 'too-large' };
		}
	}
	if (!request.body) return { type: 'ok', value: new Uint8Array() };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > bodyLimit) {
				void reader.cancel();
				return { type: 'too-large' };
			}
			chunks.push(value);
		}
	} catch {
		return { type: 'invalid' };
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { type: 'ok', value: body };
}

function parseJson(body: Uint8Array): unknown {
	try {
		return JSON.parse(decoder.decode(body));
	} catch {
		return undefined;
	}
}

function parseSignature(value: string | null): Uint8Array | undefined {
	const match = /^sha256=([0-9a-fA-F]{64})$/.exec(value ?? '');
	const hex = match?.[1];
	if (!hex) return undefined;
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		toArrayBuffer(encoder.encode(secret)),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	);
}

async function verifySignature(
	key: CryptoKey,
	body: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	try {
		return crypto.subtle.verify(
			'HMAC',
			key,
			toArrayBuffer(signature),
			toArrayBuffer(body),
		);
	} catch {
		return false;
	}
}

async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.digest('SHA-256', encoder.encode(value)),
	);
}

function secureEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < left.byteLength; index += 1) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}

function readSingleQuery(url: URL, name: string): string | undefined {
	const values = url.searchParams.getAll(name);
	return values.length === 1 ? values[0] : undefined;
}

function readRecord(
	value: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const item = value[key];
	return isRecord(item) ? item : undefined;
}

function readString(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	const item = value[key];
	return typeof item === 'string' ? item : undefined;
}

function readNonEmptyString(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	const item = readString(value, key);
	return item && item.trim() === item ? item : undefined;
}

function readOptionalString(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	if (value[key] === undefined) return undefined;
	return readString(value, key);
}

function readStringOrNumber(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	const item = value[key];
	if (typeof item === 'string' && item.length > 0) return item;
	if (typeof item === 'number' && Number.isSafeInteger(item)) return String(item);
	return undefined;
}

function readSafeInteger(
	value: Record<string, unknown>,
	key: string,
): number | undefined {
	const item = value[key];
	return typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
		? item
		: undefined;
}

function readIntegerLike(
	value: Record<string, unknown>,
	key: string,
): number | undefined {
	const item = value[key];
	if (typeof item === 'number') {
		return Number.isSafeInteger(item) && item >= 0 ? item : undefined;
	}
	if (typeof item === 'string' && /^\d+$/.test(item)) {
		const parsed = Number(item);
		return Number.isSafeInteger(parsed) ? parsed : undefined;
	}
	return undefined;
}

function normalizeStringArray(value: unknown): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return undefined;
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string' || item.length === 0) return undefined;
		result.push(item);
	}
	return result;
}

function hasInvalidOptionalString(
	value: Record<string, unknown>,
	key: string,
	normalized: string | undefined,
): boolean {
	return value[key] !== undefined && normalized === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

type HandlerOutcome<T> =
	| { type: 'success'; value: T }
	| { type: 'failure' }
	| { type: 'timeout' };

async function runHandler<T>(
	handler: () => T | Promise<T>,
	timeoutMs: number,
): Promise<HandlerOutcome<T>> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const handlerPromise = Promise.resolve()
		.then(handler)
		.then(
			(value): HandlerOutcome<T> => ({ type: 'success', value }),
			(): HandlerOutcome<T> => ({ type: 'failure' }),
		);
	const timeoutPromise = new Promise<HandlerOutcome<T>>((resolve) => {
		timeout = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
	});
	const outcome = await Promise.race([handlerPromise, timeoutPromise]);
	if (timeout !== undefined) clearTimeout(timeout);
	return outcome;
}

function serializeHandlerResult(value: unknown): Response {
	if (value instanceof Response) return value;
	if (value === undefined) {
		return new Response(EVENT_RECEIVED, {
			status: 200,
			headers: { 'content-type': 'text/plain; charset=UTF-8' },
		});
	}
	if (!isJsonValue(value)) return response(500);
	return Response.json(value);
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return true;
	}
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object') return false;
	if (seen.has(value)) return false;
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
		return false;
	}
	seen.add(value);
	try {
		return Array.isArray(value)
			? value.every((item) => isJsonValue(item, seen))
			: Object.values(value).every((item) => isJsonValue(item, seen));
	} finally {
		seen.delete(value);
	}
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

function response(status: number): Response {
	return new Response(null, { status });
}
