/**
 * Narrow re-export of the xAI grant for the model-routing layer.
 *
 * `byo-providers` needs to read the stored xAI token, but `auth-store` imports
 * `config` for BASE_DIR and `config` is what `byo-providers` reads its keys
 * from — importing the store directly from the routing layer risks a cycle
 * through that triangle. This module exists only to keep the dependency
 * direction one-way and obvious; it adds no behaviour of its own.
 */
export {
  getStoredXaiOAuthTokens,
  saveXaiOAuthTokens,
  clearXaiOAuthTokens,
  xaiOAuthConnected,
  xaiAccessTokenExpiresSoon,
  getFreshXaiAccessToken,
  type StoredXaiOAuthTokens,
} from './auth-store.js';
