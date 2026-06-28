import { ASSISTANT_NAME } from '../config.js';

/**
 * Canonical Slack app manifest for connecting Clementine via Socket Mode.
 *
 * Single source of truth shared by the `clementine slack scopes` CLI helper
 * and the dashboard's guided "Connect Slack" panel (served via
 * GET /api/console/slack/status). Pasting this at
 * https://api.slack.com/apps?new_app=1 → "From a manifest" pre-configures
 * every scope, event subscription, and Socket Mode — so the user only has to
 * Install and copy two tokens.
 *
 * Socket Mode means NO public request URL is needed (the daemon opens an
 * outbound WebSocket, exactly like Discord's gateway). The two events are the
 * minimum for two-way chat: message.im (DMs) + app_mention (channel mentions).
 */
export const SLACK_APP_MANIFEST_YAML = `display_information:
  name: ${ASSISTANT_NAME}
  description: Your AI chief of staff, in Slack.
  background_color: "#1a1a1a"
features:
  bot_user:
    display_name: ${ASSISTANT_NAME}
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - im:history
      - im:read
      - im:write
      - channels:history
      - groups:history
      - users:read
      - files:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
`;
