import { defineTool, dispatch } from '@flue/runtime';
import {
	createTwilioChannel,
	type TwilioConversationRef,
} from '@flue/twilio';
import assistant from '../agents/assistant.ts';
import { TwilioClient } from '../twilio-client.ts';

export const client = new TwilioClient({
	accountSid: requiredEnv('TWILIO_ACCOUNT_SID'),
	authToken: requiredEnv('TWILIO_AUTH_TOKEN'),
});

export const channel = createTwilioChannel({
	accountSid: requiredEnv('TWILIO_ACCOUNT_SID'),
	authToken: requiredEnv('TWILIO_AUTH_TOKEN'),
	webhookUrl: requiredEnv('TWILIO_WEBHOOK_URL'),
	destination: {
		type: 'address',
		address: requiredEnv('TWILIO_PHONE_NUMBER'),
	},

	// Path: /channels/twilio/webhook
	async webhook({ message }) {
		if (message.optOut?.type === 'stop') return;
		await dispatch(assistant, {
			id: channel.conversationKey(message.conversation),
			input: {
				type: 'twilio.message',
				messageSid: message.sid,
				from: message.from,
				text: message.body,
				media: message.media.map(({ index, contentType }) => ({
					index,
					contentType,
				})),
				optOut: message.optOut,
			},
		});
	},
});

export function postMessage(ref: TwilioConversationRef) {
	return defineTool({
		name: 'post_twilio_message',
		description: 'Post a message to the Twilio conversation bound to this agent.',
		parameters: {
			type: 'object',
			properties: {
				text: { type: 'string', minLength: 1 },
			},
			required: ['text'],
			additionalProperties: false,
		},
		async execute({ text }) {
			const result = await client.messages.create({
				to: ref.participant,
				body: text,
				...(ref.type === 'messaging-service'
					? { messagingServiceSid: ref.messagingServiceSid }
					: { from: ref.address }),
			});
			return JSON.stringify({ messageSid: result.sid });
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
