import type { Env, Handler } from 'hono';
import type {
	TwilioChannelOptions,
	TwilioConversationRef,
	TwilioDestination,
	TwilioFormParameters,
	TwilioHandlerResult,
	TwilioIncomingMessage,
	TwilioLocation,
	TwilioMedia,
	TwilioMessageState,
	TwilioMessageStatus,
	TwilioOptOut,
	TwilioRichMessageMetadata,
} from './index.ts';

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

interface ConfiguredUrl {
	signatureUrl: string;
	query: string;
}

interface ParsedForm {
	values: ReadonlyMap<string, readonly string[]>;
	raw: TwilioFormParameters;
	entryCount: number;
}

export function createTwilioWebhookHandler<E extends Env>(
	options: TwilioChannelOptions<E>,
): Handler<E> {
	const bodyLimit = resolveBodyLimit(options.bodyLimit);
	const configuredUrl = parseConfiguredUrl(options.webhookUrl);
	const key = importSigningKey(options.authToken);

	return async (c) => {
		const accepted = await acceptSignedForm(
			c.req.raw,
			configuredUrl,
			bodyLimit,
			key,
		);
		if (accepted instanceof Response) return accepted;
		const message = normalizeIncomingMessage(
			accepted.form,
			accepted.idempotencyToken,
			options.destination,
		);
		if (!message) return response(400);
		if (!matchesIncomingIdentity(options, message)) return response(403);

		let result: TwilioHandlerResult;
		try {
			result = await options.webhook({ c, message });
		} catch {
			return response(500);
		}
		return serializeHandlerResult(result, true);
	};
}

export function createTwilioStatusCallbackHandler<E extends Env>(
	options: TwilioChannelOptions<E>,
): Handler<E> {
	const bodyLimit = resolveBodyLimit(options.bodyLimit);
	const configuredUrl = parseConfiguredUrl(options.statusCallbackUrl as string);
	const key = importSigningKey(options.authToken);
	const callback = options.statusCallback as NonNullable<
		TwilioChannelOptions<E>['statusCallback']
	>;

	return async (c) => {
		const accepted = await acceptSignedForm(
			c.req.raw,
			configuredUrl,
			bodyLimit,
			key,
		);
		if (accepted instanceof Response) return accepted;
		const status = normalizeMessageStatus(
			accepted.form,
			accepted.idempotencyToken,
			options,
		);
		if (!status) return response(400);
		if (!matchesStatusIdentity(options, status)) return response(403);

		let result: TwilioHandlerResult;
		try {
			result = await callback({ c, status });
		} catch {
			return response(500);
		}
		return serializeHandlerResult(result, false);
	};
}

async function acceptSignedForm(
	request: Request,
	configuredUrl: ConfiguredUrl,
	bodyLimit: number,
	key: Promise<CryptoKey>,
): Promise<
	| {
			form: ParsedForm;
			idempotencyToken?: string;
	  }
	| Response
> {
	if (!isFormRequest(request)) return response(415);
	if (!matchesConfiguredQuery(request.url, configuredUrl.query)) {
		return response(400);
	}

	const body = await readBody(request, bodyLimit);
	if (body.type === 'too-large') return response(413);
	if (body.type === 'invalid') return response(400);
	const form = parseForm(body.value);
	if (!form) return response(400);

	const signature = request.headers.get('x-twilio-signature');
	if (
		!signature ||
		!(await verifySignature(
			await key,
			signature,
			configuredUrl.signatureUrl,
			form.values,
		))
	) {
		return response(401);
	}

	const idempotencyToken = optionalHeader(
		request.headers.get('i-twilio-idempotency-token'),
	);
	return {
		form,
		...(idempotencyToken === undefined ? {} : { idempotencyToken }),
	};
}

function normalizeIncomingMessage(
	form: ParsedForm,
	idempotencyToken: string | undefined,
	destination: TwilioDestination,
): TwilioIncomingMessage | undefined {
	const sid = single(form.values, 'MessageSid');
	const accountSid = single(form.values, 'AccountSid');
	const from = single(form.values, 'From');
	const to = single(form.values, 'To');
	const body = single(form.values, 'Body');
	const numMediaValue = single(form.values, 'NumMedia');
	const numSegmentsValue = single(form.values, 'NumSegments');
	if (
		!isRequired(sid) ||
		!isRequired(accountSid) ||
		!isRequired(from) ||
		!isRequired(to) ||
		body === undefined ||
		body === null ||
		!isRequired(numMediaValue) ||
		!isRequired(numSegmentsValue)
	) {
		return undefined;
	}

	const numMedia = parseNonNegativeInteger(numMediaValue);
	const numSegments = parsePositiveInteger(numSegmentsValue);
	if (
		numMedia === undefined ||
		numSegments === undefined ||
		numMedia > form.entryCount
	) {
		return undefined;
	}

	const messagingServiceSid = optionalNonEmpty(form.values, 'MessagingServiceSid');
	if (messagingServiceSid === null) return undefined;
	const media = normalizeMedia(form.values, numMedia);
	if (!media) return undefined;
	const optOut = normalizeOptOut(form.values);
	if (optOut === null) return undefined;
	const location = normalizeLocation(form.values);
	if (location === null) return undefined;
	const rich = normalizeRichMetadata(form.values);
	if (rich === null) return undefined;

	const conversation: TwilioConversationRef =
		destination.type === 'address'
			? {
					type: 'address',
					accountSid,
					address: to,
					participant: from,
				}
			: {
					type: 'messaging-service',
					accountSid,
					messagingServiceSid: destination.messagingServiceSid,
					address: to,
					participant: from,
				};

	return {
		sid,
		accountSid,
		from,
		to,
		body,
		numSegments,
		...(messagingServiceSid === undefined ? {} : { messagingServiceSid }),
		media,
		...(optOut === undefined ? {} : { optOut }),
		...(location === undefined ? {} : { location }),
		...(rich === undefined ? {} : { rich }),
		...(idempotencyToken === undefined ? {} : { idempotencyToken }),
		conversation,
		raw: form.raw,
	};
}

function normalizeMessageStatus<E extends Env>(
	form: ParsedForm,
	idempotencyToken: string | undefined,
	options: TwilioChannelOptions<E>,
): TwilioMessageStatus | undefined {
	const messageSid = single(form.values, 'MessageSid');
	const accountSid = single(form.values, 'AccountSid');
	const providerState = single(form.values, 'MessageStatus');
	if (
		!isRequired(messageSid) ||
		!isRequired(accountSid) ||
		!isRequired(providerState)
	) {
		return undefined;
	}

	const from = optionalNonEmpty(form.values, 'From');
	const to = optionalNonEmpty(form.values, 'To');
	const messagingServiceSid = optionalNonEmpty(
		form.values,
		'MessagingServiceSid',
	);
	const errorMessage = optionalNonEmpty(form.values, 'ErrorMessage');
	const channelStatusMessage = optionalNonEmpty(
		form.values,
		'ChannelStatusMessage',
	);
	const rawDlrDoneDate = optionalNonEmpty(form.values, 'RawDlrDoneDate');
	if (
		from === null ||
		to === null ||
		messagingServiceSid === null ||
		errorMessage === null ||
		channelStatusMessage === null ||
		rawDlrDoneDate === null
	) {
		return undefined;
	}

	const errorCodeValue = optionalNonEmpty(form.values, 'ErrorCode');
	if (errorCodeValue === null) return undefined;
	const errorCode =
		errorCodeValue === undefined
			? undefined
			: parseNonNegativeInteger(errorCodeValue);
	if (errorCodeValue !== undefined && errorCode === undefined) return undefined;

	const conversation = statusConversation(
		options,
		accountSid,
		from,
		to,
	);
	return {
		messageSid,
		accountSid,
		state: normalizeMessageState(providerState),
		providerState,
		...(from === undefined ? {} : { from }),
		...(to === undefined ? {} : { to }),
		...(messagingServiceSid === undefined ? {} : { messagingServiceSid }),
		...(errorCode === undefined ? {} : { errorCode }),
		...(errorMessage === undefined ? {} : { errorMessage }),
		...(channelStatusMessage === undefined ? {} : { channelStatusMessage }),
		...(rawDlrDoneDate === undefined ? {} : { rawDlrDoneDate }),
		...(idempotencyToken === undefined ? {} : { idempotencyToken }),
		...(conversation === undefined ? {} : { conversation }),
		raw: form.raw,
	};
}

function normalizeMedia(
	form: ReadonlyMap<string, readonly string[]>,
	count: number,
): readonly TwilioMedia[] | undefined {
	const media: TwilioMedia[] = [];
	for (let index = 0; index < count; index += 1) {
		const url = single(form, `MediaUrl${index}`);
		const contentType = single(form, `MediaContentType${index}`);
		if (!isRequired(url) || !isRequired(contentType)) return undefined;
		media.push({ index, url, contentType });
	}
	return media;
}

function normalizeOptOut(
	form: ReadonlyMap<string, readonly string[]>,
): TwilioOptOut | undefined | null {
	const providerType = optionalNonEmpty(form, 'OptOutType');
	if (providerType === null || providerType === undefined) return providerType;
	const normalized = providerType.toUpperCase();
	return {
		type:
			normalized === 'START'
				? 'start'
				: normalized === 'STOP'
					? 'stop'
					: normalized === 'HELP'
						? 'help'
						: 'unknown',
		providerType,
	};
}

function normalizeLocation(
	form: ReadonlyMap<string, readonly string[]>,
): TwilioLocation | undefined | null {
	const latitudeValue = optionalNonEmpty(form, 'Latitude');
	const longitudeValue = optionalNonEmpty(form, 'Longitude');
	const fromCity = optionalNonEmpty(form, 'FromCity');
	const fromState = optionalNonEmpty(form, 'FromState');
	const fromZip = optionalNonEmpty(form, 'FromZip');
	const fromCountry = optionalNonEmpty(form, 'FromCountry');
	const toCity = optionalNonEmpty(form, 'ToCity');
	const toState = optionalNonEmpty(form, 'ToState');
	const toZip = optionalNonEmpty(form, 'ToZip');
	const toCountry = optionalNonEmpty(form, 'ToCountry');
	if (
		latitudeValue === null ||
		longitudeValue === null ||
		fromCity === null ||
		fromState === null ||
		fromZip === null ||
		fromCountry === null ||
		toCity === null ||
		toState === null ||
		toZip === null ||
		toCountry === null
	) {
		return null;
	}
	const values = [
		latitudeValue,
		longitudeValue,
		fromCity,
		fromState,
		fromZip,
		fromCountry,
		toCity,
		toState,
		toZip,
		toCountry,
	];
	const latitude =
		latitudeValue === undefined ? undefined : parseFiniteNumber(latitudeValue);
	const longitude =
		longitudeValue === undefined
			? undefined
			: parseFiniteNumber(longitudeValue);
	if (
		(latitudeValue !== undefined && latitude === undefined) ||
		(longitudeValue !== undefined && longitude === undefined)
	) {
		return null;
	}
	if (values.every((value) => value === undefined)) return undefined;
	return {
		...(latitude === undefined ? {} : { latitude }),
		...(longitude === undefined ? {} : { longitude }),
		...(fromCity === undefined ? {} : { fromCity }),
		...(fromState === undefined ? {} : { fromState }),
		...(fromZip === undefined ? {} : { fromZip }),
		...(fromCountry === undefined ? {} : { fromCountry }),
		...(toCity === undefined ? {} : { toCity }),
		...(toState === undefined ? {} : { toState }),
		...(toZip === undefined ? {} : { toZip }),
		...(toCountry === undefined ? {} : { toCountry }),
	};
}

function normalizeRichMetadata(
	form: ReadonlyMap<string, readonly string[]>,
): TwilioRichMessageMetadata | undefined | null {
	const buttonPayload = optionalString(form, 'ButtonPayload');
	const buttonText = optionalString(form, 'ButtonText');
	const originalRepliedMessageSender = optionalString(
		form,
		'OriginalRepliedMessageSender',
	);
	const originalRepliedMessageSid = optionalString(
		form,
		'OriginalRepliedMessageSid',
	);
	const referralNumMediaValue = optionalNonEmpty(form, 'ReferralNumMedia');
	const referralMediaContentType = optionalString(
		form,
		'ReferralMediaContentType0',
	);
	const referralMediaUrl = optionalString(form, 'ReferralMediaUrl0');
	const referralBody = optionalString(form, 'ReferralBody');
	const referralHeadline = optionalString(form, 'ReferralHeadline');
	const channelMetadata = optionalString(form, 'ChannelMetadata');
	const interactiveData = optionalString(form, 'InteractiveData');
	const flowData = optionalString(form, 'FlowData');
	if (
		buttonPayload === null ||
		buttonText === null ||
		originalRepliedMessageSender === null ||
		originalRepliedMessageSid === null ||
		referralNumMediaValue === null ||
		referralMediaContentType === null ||
		referralMediaUrl === null ||
		referralBody === null ||
		referralHeadline === null ||
		channelMetadata === null ||
		interactiveData === null ||
		flowData === null
	) {
		return null;
	}
	const values = [
		buttonPayload,
		buttonText,
		originalRepliedMessageSender,
		originalRepliedMessageSid,
		referralNumMediaValue,
		referralMediaContentType,
		referralMediaUrl,
		referralBody,
		referralHeadline,
		channelMetadata,
		interactiveData,
		flowData,
	];
	const referralNumMedia =
		referralNumMediaValue === undefined
			? undefined
			: parseNonNegativeInteger(referralNumMediaValue);
	if (
		referralNumMediaValue !== undefined &&
		referralNumMedia === undefined
	) {
		return null;
	}
	if (values.every((value) => value === undefined)) return undefined;
	return {
		...(buttonPayload === undefined ? {} : { buttonPayload }),
		...(buttonText === undefined ? {} : { buttonText }),
		...(originalRepliedMessageSender === undefined
			? {}
			: { originalRepliedMessageSender }),
		...(originalRepliedMessageSid === undefined
			? {}
			: { originalRepliedMessageSid }),
		...(referralNumMedia === undefined ? {} : { referralNumMedia }),
		...(referralMediaContentType === undefined
			? {}
			: { referralMediaContentType }),
		...(referralMediaUrl === undefined ? {} : { referralMediaUrl }),
		...(referralBody === undefined ? {} : { referralBody }),
		...(referralHeadline === undefined ? {} : { referralHeadline }),
		...(channelMetadata === undefined ? {} : { channelMetadata }),
		...(interactiveData === undefined ? {} : { interactiveData }),
		...(flowData === undefined ? {} : { flowData }),
	};
}

function matchesIncomingIdentity<E extends Env>(
	options: TwilioChannelOptions<E>,
	message: TwilioIncomingMessage,
): boolean {
	if (message.accountSid !== options.accountSid) return false;
	return options.destination.type === 'address'
		? message.to === options.destination.address
		: message.messagingServiceSid === options.destination.messagingServiceSid;
}

function matchesStatusIdentity<E extends Env>(
	options: TwilioChannelOptions<E>,
	status: TwilioMessageStatus,
): boolean {
	if (status.accountSid !== options.accountSid) return false;
	return options.destination.type === 'address'
		? status.from === options.destination.address
		: status.messagingServiceSid === undefined ||
				status.messagingServiceSid === options.destination.messagingServiceSid;
}

function statusConversation<E extends Env>(
	options: TwilioChannelOptions<E>,
	accountSid: string,
	from: string | undefined,
	to: string | undefined,
): TwilioConversationRef | undefined {
	if (!from || !to) return undefined;
	return options.destination.type === 'address'
		? {
				type: 'address',
				accountSid,
				address: from,
				participant: to,
			}
		: {
				type: 'messaging-service',
				accountSid,
				messagingServiceSid: options.destination.messagingServiceSid,
				address: from,
				participant: to,
			};
}

function normalizeMessageState(value: string): TwilioMessageState {
	switch (value.toLowerCase()) {
		case 'accepted':
		case 'scheduled':
		case 'queued':
		case 'sending':
		case 'sent':
		case 'delivered':
		case 'undelivered':
		case 'failed':
		case 'read':
		case 'canceled':
		case 'receiving':
		case 'received':
			return value.toLowerCase() as TwilioMessageState;
		default:
			return 'unknown';
	}
}

function parseConfiguredUrl(value: string): ConfiguredUrl {
	const fragmentIndex = value.indexOf('#');
	const signatureUrl =
		fragmentIndex === -1 ? value : value.slice(0, fragmentIndex);
	const parsed = new URL(signatureUrl);
	return {
		signatureUrl,
		query: parsed.search,
	};
}

function matchesConfiguredQuery(requestUrl: string, query: string): boolean {
	const parsed = new URL(requestUrl);
	return parsed.search === query;
}

function resolveBodyLimit(value: number | undefined): number {
	const bodyLimit = value ?? DEFAULT_BODY_LIMIT;
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
		throw new TypeError('Twilio webhook bodyLimit must be a positive integer.');
	}
	return bodyLimit;
}

function isFormRequest(request: Request): boolean {
	return (
		request.headers
			.get('content-type')
			?.split(';', 1)[0]
			?.trim()
			.toLowerCase() === 'application/x-www-form-urlencoded'
	);
}

function parseForm(body: string): ParsedForm | undefined {
	let params: URLSearchParams;
	try {
		params = new URLSearchParams(body);
	} catch {
		return undefined;
	}
	const mutable = new Map<string, string[]>();
	let entryCount = 0;
	for (const [name, value] of params) {
		entryCount += 1;
		const values = mutable.get(name);
		if (values) values.push(value);
		else mutable.set(name, [value]);
	}
	const raw: Record<string, string | readonly string[]> = {};
	for (const [name, values] of mutable) {
		Object.defineProperty(raw, name, {
			value: values.length === 1 ? values[0] : Object.freeze([...values]),
			enumerable: true,
		});
	}
	return { values: mutable, raw: Object.freeze(raw), entryCount };
}

async function importSigningKey(authToken: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(authToken),
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['verify'],
	);
}

async function verifySignature(
	key: CryptoKey,
	signature: string,
	url: string,
	form: ReadonlyMap<string, readonly string[]>,
): Promise<boolean> {
	const signatureBytes = decodeBase64(signature);
	if (!signatureBytes) return false;
	const names = [...form.keys()].sort();
	let data = url;
	for (const name of names) {
		const values = [...new Set(form.get(name) ?? [])].sort();
		for (const value of values) data += `${name}${value}`;
	}
	try {
		return crypto.subtle.verify(
			'HMAC',
			key,
			toArrayBuffer(signatureBytes),
			toArrayBuffer(encoder.encode(data)),
		);
	} catch {
		return false;
	}
}

function decodeBase64(value: string): Uint8Array | undefined {
	try {
		const decoded = atob(value);
		const bytes = new Uint8Array(decoded.length);
		for (let index = 0; index < decoded.length; index += 1) {
			bytes[index] = decoded.charCodeAt(index);
		}
		return bytes;
	} catch {
		return undefined;
	}
}

function single(
	form: ReadonlyMap<string, readonly string[]>,
	name: string,
): string | undefined | null {
	const values = form.get(name);
	if (!values) return undefined;
	return values.length === 1 ? (values[0] as string) : null;
}

function optionalString(
	form: ReadonlyMap<string, readonly string[]>,
	name: string,
): string | undefined | null {
	return single(form, name);
}

function optionalNonEmpty(
	form: ReadonlyMap<string, readonly string[]>,
	name: string,
): string | undefined | null {
	const value = single(form, name);
	if (value === undefined || value === null) return value;
	return value.length === 0 ? undefined : value;
}

function isRequired(value: string | undefined | null): value is string {
	return typeof value === 'string' && value.length > 0;
}

function parseNonNegativeInteger(value: string): number | undefined {
	if (!/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parsePositiveInteger(value: string): number | undefined {
	const parsed = parseNonNegativeInteger(value);
	return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function parseFiniteNumber(value: string): number | undefined {
	if (value.trim() !== value || value.length === 0) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalHeader(value: string | null): string | undefined {
	return value && value.trim() === value ? value : undefined;
}

async function readBody(
	request: Request,
	limit: number,
): Promise<
	| { type: 'ok'; value: string }
	| { type: 'too-large' }
	| { type: 'invalid' }
> {
	const contentLength = request.headers.get('content-length');
	if (contentLength) {
		const length = Number(contentLength);
		if (Number.isFinite(length) && length > limit) return { type: 'too-large' };
	}
	if (!request.body) return { type: 'ok', value: '' };

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel();
				return { type: 'too-large' };
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { type: 'ok', value: decoder.decode(bytes) };
	} catch {
		return { type: 'invalid' };
	}
}

function serializeHandlerResult(value: unknown, twiml: boolean): Response {
	if (value instanceof Response) return value;
	if (value !== undefined) return response(500);
	return twiml
		? new Response(EMPTY_TWIML, {
				status: 200,
				headers: { 'content-type': 'text/xml; charset=UTF-8' },
			})
		: response(200);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

function response(status: number): Response {
	return new Response(null, { status });
}
