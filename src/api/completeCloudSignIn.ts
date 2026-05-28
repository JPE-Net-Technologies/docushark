/**
 * Shared tail of a successful Cloud sign-in: commit the relay app token,
 * persist the connection record, and start a collaboration session.
 *
 * Extracted from `RelaySettings.handleSignIn` (JP-100) so the device-code flow
 * and the (deferred) web `/auth/callback` redirect drive the *same* proven
 * "token → persist → start session" path rather than duplicating it.
 */

import { useConnectionStore } from '../store/connectionStore';
import { useCollaborationStore } from '../collaboration';
import { saveConnection } from './relayConnection';

/** Convert a REST origin (http://host:port) to the matching WS URL (ws://host:port/ws). */
function restUrlToWsUrl(restUrl: string): string {
  return restUrl
    .replace(/\/+$/, '')
    .replace(/^http:\/\//, 'ws://')
    .replace(/^https:\/\//, 'wss://')
    .concat('/ws');
}

export interface CompleteCloudSignInArgs {
  /** Relay REST origin, e.g. `http://localhost:9876`. */
  relayUrl: string;
  /** docushark-web origin — persisted so it pre-fills the sign-in form next time. */
  cloudBaseUrl: string;
  /** Relay app token (RS256 JWT). */
  token: string;
  /** Absolute token expiry (Unix ms), or null if unknown. */
  expiresAt: number | null;
  /** Document to open on connect; falls back to `'default'`. */
  documentId?: string | null;
}

export async function completeCloudSignIn(args: CompleteCloudSignInArgs): Promise<void> {
  const { relayUrl, cloudBaseUrl, token, expiresAt, documentId } = args;

  // Make the token available to the REST client seed + persist it alongside the
  // URLs before the session subscribes.
  useConnectionStore.getState().setToken(token, expiresAt);
  await saveConnection(relayUrl, token, { cloudBaseUrl, jwtExpiresAt: expiresAt });

  useCollaborationStore.getState().startSession({
    serverUrl: restUrlToWsUrl(relayUrl),
    documentId: documentId ?? 'default',
    token,
    user: { id: 'pending', name: 'You', color: '#4a90d9' },
  });
}
