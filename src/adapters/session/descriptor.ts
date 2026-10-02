// The §23 descriptor as the text a person copies: the envelope encoded and decoded to a string. TextDecoder is a host
// global (browser and Node), so this lives in the adapters layer rather than in the DOM-free session-view. Both
// session adapters (memory, webrtc) mint the invite string through it.
import type {SessionDescriptor} from '../../presentation/session-view';
import {sessionEnvelope} from '../../presentation/session-view';
import type {JsonValue} from '../../world/model';
import type {WorldCodec} from '../../world/ports';

export const sessionText = (descriptor: SessionDescriptor, codec: WorldCodec): string =>
 new TextDecoder().decode(codec.encode(sessionEnvelope(descriptor) as unknown as JsonValue));
