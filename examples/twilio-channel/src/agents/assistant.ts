import { createAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/twilio.ts';

export default createAgent(({ id }) => ({
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Reply concisely in the bound Twilio conversation.',
	tools: [postMessage(channel.parseConversationKey(id))],
}));
