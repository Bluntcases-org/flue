import type { FlueEvent as RuntimeFlueEvent } from '@flue/runtime';
import type { FlueEvent as SdkFlueEvent } from '../src/index.ts';

// `turn_request` is in-process only (`observe()` subscribers and exporters);
// it is never persisted to durable streams or served over HTTP, so the SDK
// wire union deliberately omits it.
const _: SdkFlueEvent = {} as Exclude<RuntimeFlueEvent, { type: 'turn_request' }>;
void _;
