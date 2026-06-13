# @flue/twilio

Verified Twilio Programmable Messaging ingress for Flue channels.

```ts
import { createTwilioChannel } from '@flue/twilio';

export const channel = createTwilioChannel({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  webhookUrl: process.env.TWILIO_WEBHOOK_URL!,
  destination: {
    type: 'address',
    address: process.env.TWILIO_PHONE_NUMBER!,
  },
  webhook({ message }) {
    // Handle one verified SMS or MMS message.
  },
});
```

The package owns signature validation, fixed account and destination checks,
typed message and status normalization, TwiML acknowledgement, and canonical
conversation identity. Applications own credentials, outbound Fetch clients,
tools, dispatch policy, and deduplication.

See the prepared package docs or
<https://flueframework.com/docs/guide/channels/twilio/>.
