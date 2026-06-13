import {
	createMessengerChannel,
	type MessengerConversationRef,
} from '@flue/messenger';
import { defineTool, dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';
import { MessengerClient } from '../messenger-client.ts';

export const client = new MessengerClient({
	pageId: requiredEnv('MESSENGER_PAGE_ID'),
	pageAccessToken: requiredEnv('MESSENGER_PAGE_ACCESS_TOKEN'),
	graphVersion: 'v25.0',
});

export const channel = createMessengerChannel({
	appSecret: requiredEnv('MESSENGER_APP_SECRET'),
	verifyToken: requiredEnv('MESSENGER_VERIFY_TOKEN'),
	pageId: requiredEnv('MESSENGER_PAGE_ID'),

	// Paths: GET and POST /channels/messenger/webhook
	async webhook({ delivery }) {
		for (const event of delivery.events) {
			switch (event.type) {
				case 'message': {
					if (event.message.text === undefined) continue;
					await dispatch(assistant, {
						id: channel.conversationKey(event.conversation),
						input: {
							type: 'messenger.message',
							messageId: event.message.id,
							text: event.message.text,
							attachmentTypes: event.message.attachments.map(
								(attachment) => attachment.type,
							),
							quickReplyPayload: event.message.quickReplyPayload,
						},
					});
					break;
				}
				case 'message_edit':
					await dispatch(assistant, {
						id: channel.conversationKey(event.conversation),
						input: {
							type: 'messenger.message_edit',
							messageId: event.messageId,
							text: event.text,
							editCount: event.editCount,
						},
					});
					break;
				case 'postback':
					await dispatch(assistant, {
						id: channel.conversationKey(event.conversation),
						input: {
							type: 'messenger.postback',
							messageId: event.messageId,
							title: event.title,
							payload: event.payload,
						},
					});
					break;
				case 'message_echo':
				case 'reaction':
				case 'delivery':
				case 'read':
				case 'optin':
				case 'referral':
				case 'unknown':
					break;
			}
		}
	},
});

export function postMessage(ref: MessengerConversationRef) {
	return defineTool({
		name: 'post_messenger_message',
		description:
			'Post a message to the Facebook Messenger conversation bound to this agent.',
		parameters: {
			type: 'object',
			properties: {
				text: { type: 'string', minLength: 1 },
			},
			required: ['text'],
			additionalProperties: false,
		},
		async execute({ text }) {
			const result = await client.messages.sendText({
				to: ref.participant,
				text,
			});
			return JSON.stringify({ messageId: result.messageId });
		},
	});
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
