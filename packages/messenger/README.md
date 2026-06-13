# @flue/messenger

Verified Facebook Messenger Page ingress for Flue channels.

```ts
import { createMessengerChannel } from '@flue/messenger';

export const channel = createMessengerChannel({
  appSecret: process.env.MESSENGER_APP_SECRET!,
  verifyToken: process.env.MESSENGER_VERIFY_TOKEN!,
  pageId: process.env.MESSENGER_PAGE_ID!,
  webhook({ delivery }) {
    // Handle one verified, potentially batched Page delivery.
  },
});
```

The package owns verification, exact-body signatures, fixed Page identity,
typed event normalization, acknowledgement deadlines, and canonical
conversation identity. Applications own Page access tokens, outbound Graph
clients, tools, dispatch policy, and deduplication.

See the prepared package docs or
<https://flueframework.com/docs/guide/channels/messenger/>.
