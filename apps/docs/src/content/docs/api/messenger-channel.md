---
title: Messenger Channel API
description: Reference for verified Facebook Messenger Page ingress from @flue/messenger.
lastReviewedAt: 2026-06-13
---

Import from `@flue/messenger`.

## `createMessengerChannel()`

```ts
function createMessengerChannel<E extends Env = Env>(
  options: MessengerChannelOptions<E>,
): MessengerChannel<E>;
```

Creates GET verification and signed POST delivery routes at `/webhook` for one
fixed Facebook Page.

## `MessengerChannelOptions`

```ts
interface MessengerChannelOptions<E extends Env = Env> {
  appSecret: string;
  verifyToken: string;
  pageId: string;
  bodyLimit?: number;
  handlerTimeoutMs?: number;
  webhook(input: MessengerWebhookHandlerInput<E>): MessengerHandlerResult;
}
```

| Field              | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| `appSecret`        | Meta app secret for exact-body HMAC-SHA256 validation.        |
| `verifyToken`      | User-chosen token for Meta's GET verification handshake.      |
| `pageId`           | Required Page id in every accepted entry and event.           |
| `bodyLimit`        | Maximum JSON body. Default: 1 MiB.                            |
| `handlerTimeoutMs` | Handler deadline. Default and maximum: 4500 ms.               |
| `webhook`          | Callback for one verified, potentially batched HTTP delivery. |

## `MessengerChannel`

```ts
interface MessengerChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: MessengerConversationRef): string;
  parseConversationKey(id: string): MessengerConversationRef;
}
```

A file named `channels/messenger.ts` serves GET and POST requests at
`/channels/messenger/webhook` relative to the `flue()` mount.

The channel is stateless. It does not persist or deduplicate messages,
deliveries, reads, or retries.

## Handler input

```ts
interface MessengerWebhookHandlerInput<E extends Env = Env> {
  c: Context<E>;
  delivery: MessengerWebhookDelivery;
}

interface MessengerWebhookDelivery {
  object: 'page';
  events: readonly MessengerWebhookEvent[];
  raw: unknown;
}
```

`delivery.events` preserves deterministic entry and provider-collection
positions. Every event includes:

- `pageId`, `entryTime`, `entryIndex`, `collection`, and `itemIndex`;
- optional provider `timestamp`;
- the verified provider object under `raw`.

## Event types

`MessengerWebhookEvent` is a union of:

| `type`         | Additional fields                                                  |
| -------------- | ------------------------------------------------------------------ |
| `message`      | `message`, `conversation`                                          |
| `message_echo` | `message`, optional `appId` and `metadata`, `conversation`         |
| `message_edit` | `messageId`, `text`, `editCount`, `conversation`                   |
| `postback`     | optional `messageId`, `title`, `payload`, `referral`, conversation |
| `reaction`     | `messageId`, normalized and provider actions, reaction, emoji      |
| `delivery`     | `messageIds`, `watermark`, `conversation`                          |
| `read`         | `watermark`, `conversation`                                        |
| `optin`        | opt-in metadata, optional trusted `capabilities`, `conversation`   |
| `referral`     | normalized `referral`, `conversation`                              |
| `unknown`      | `eventType`, optional `conversation`                               |

`MessengerMessage` exposes the message id, optional text, attachments, quick
reply payload, reply target, referral, and command names. Attachment payloads
remain provider-native after verification.

`MessengerOptInCapabilities.notificationMessagesToken` is a short-lived
provider capability. Keep it and complete raw payloads out of model context,
dispatch input, logs, and durable session data.

## Conversation identity

```ts
interface MessengerConversationRef {
  pageId: string;
  participant: { type: 'page-scoped-id'; id: string } | { type: 'user-ref'; id: string };
}
```

Conversation keys are canonical identifiers, not authorization capabilities.
Page-scoped ids and `user_ref` values use distinct key forms.

## Handler results

```ts
type MessengerHandlerResult =
  | undefined
  | JsonValue
  | Response
  | Promise<undefined | JsonValue | Response>;
```

Returning `undefined` produces `EVENT_RECEIVED` with status `200`. A
JSON-compatible value becomes a JSON response. An ordinary Hono or Fetch
`Response` passes through.

## Errors

- `InvalidMessengerConversationKeyError`
- `InvalidMessengerInputError`, with structured `field`

See [Facebook Messenger setup](/docs/guide/channels/messenger/) for Page
configuration and project-owned Graph API composition.
