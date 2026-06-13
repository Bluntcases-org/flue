---
title: Twilio Channel API
description: Reference for verified Twilio Programmable Messaging ingress from @flue/twilio.
lastReviewedAt: 2026-06-13
---

Import from `@flue/twilio`.

## `createTwilioChannel()`

```ts
function createTwilioChannel<E extends Env = Env>(
  options: TwilioChannelOptions<E>,
): TwilioChannel<E>;
```

Creates required `POST /webhook` ingress and optional `POST /status` ingress
for one fixed Twilio account and messaging destination.

## `TwilioChannelOptions`

```ts
interface TwilioChannelOptions<E extends Env = Env> {
  accountSid: string;
  authToken: string;
  webhookUrl: string;
  destination: TwilioDestination;
  bodyLimit?: number;
  webhook(input: TwilioWebhookHandlerInput<E>): TwilioHandlerResult;
  statusCallbackUrl?: string;
  statusCallback?(input: TwilioStatusHandlerInput<E>): TwilioHandlerResult;
}
```

| Field               | Description                                                         |
| ------------------- | ------------------------------------------------------------------- |
| `accountSid`        | Required account SID in every accepted callback.                    |
| `authToken`         | Auth token for `X-Twilio-Signature` HMAC-SHA1 validation.           |
| `webhookUrl`        | Exact externally configured inbound URL, including query strings.   |
| `destination`       | Fixed phone/channel address or Messaging Service.                   |
| `bodyLimit`         | Maximum form body. Default: 1 MiB.                                  |
| `webhook`           | Callback for one verified SMS or MMS message.                       |
| `statusCallbackUrl` | Exact public status URL. Required with `statusCallback`.            |
| `statusCallback`    | Optional delivery callback. Omitting it leaves `/status` unmounted. |

Connection-override fragments are allowed in configured URLs and excluded from
the signed URL as Twilio specifies.

```ts
type TwilioDestination =
  | { type: 'address'; address: string }
  | { type: 'messaging-service'; messagingServiceSid: string };

type TwilioHandlerResult =
  | undefined
  | Response
  | Promise<undefined | Response>;
```

Returning nothing from `webhook` produces an empty TwiML `<Response/>` with
status `200`. Returning nothing from `statusCallback` produces an empty `200`.
An ordinary Hono or Fetch `Response` passes through.

## `TwilioChannel`

```ts
interface TwilioChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: TwilioConversationRef): string;
  parseConversationKey(id: string): TwilioConversationRef;
}
```

A file named `channels/twilio.ts` serves
`/channels/twilio/webhook` and, when enabled,
`/channels/twilio/status` relative to the `flue()` mount.

The channel does not persist or deduplicate message SIDs, status transitions,
or retry tokens. Conversation keys are canonical identifiers, not
authorization capabilities.

## Incoming messages

```ts
interface TwilioWebhookHandlerInput<E extends Env = Env> {
  c: Context<E>;
  message: TwilioIncomingMessage;
}
```

`TwilioIncomingMessage` exposes:

- `sid`, `accountSid`, `from`, `to`, `body`, and `numSegments`;
- optional `messagingServiceSid`;
- ordered `TwilioMedia[]` with authenticated URL and content type;
- optional normalized Advanced Opt-Out, location, and rich-message metadata;
- optional `idempotencyToken`;
- canonical `conversation`;
- signed `raw` form fields.

Repeated form fields are preserved as arrays in `TwilioFormParameters`.
Provider-known scalar fields must occur exactly once.

## Status callbacks

```ts
interface TwilioStatusHandlerInput<E extends Env = Env> {
  c: Context<E>;
  status: TwilioMessageStatus;
}
```

`TwilioMessageStatus` exposes message and account SIDs, normalized `state`,
exact `providerState`, optional sender, recipient, Messaging Service, error,
channel, raw delivery receipt, retry identity, canonical conversation, and
signed raw fields.

Twilio does not guarantee `MessagingServiceSid` in every status callback. A
Messaging Service channel is scoped by the configured account and exact signed
callback URL; a mismatched service SID is rejected when present.

Known states are:

- `accepted`
- `scheduled`
- `queued`
- `sending`
- `sent`
- `delivered`
- `undelivered`
- `failed`
- `read`
- `canceled`
- `receiving`
- `received`

Other signed values use `unknown` while preserving `providerState`.

## Conversation identity

```ts
type TwilioConversationRef =
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
```

`address` is the concrete Twilio phone number or channel address.
`participant` is the external destination used for an outbound reply.

## Errors

- `InvalidTwilioConversationKeyError`
- `InvalidTwilioInputError`, with structured `field`

See [Twilio setup](/docs/guide/channels/twilio/) for webhook configuration and
project-owned Fetch composition.
