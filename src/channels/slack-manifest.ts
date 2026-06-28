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
 * outbound WebSocket, exactly like Discord's gateway). Two-way chat needs
 * message.im (DMs) + app_mention (channel mentions); the native AI Assistant
 * pane needs assistant:write + the two assistant_thread_* events + the
 * features.assistant_view block, which lights up the dedicated, app-owned
 * assistant container — the premium surface Discord has no equivalent for.
 */
export const SLACK_APP_MANIFEST_YAML = `display_information:
  name: ${ASSISTANT_NAME}
  description: Your AI chief of staff, in Slack.
  background_color: "#1a1a1a"
features:
  bot_user:
    display_name: ${ASSISTANT_NAME}
    always_online: true
  assistant_view:
    assistant_description: Your AI chief of staff — chat, approvals, goals, and proactive briefs, right in Slack.
    suggested_prompts:
      - title: What's on my plate?
        message: Give me a quick brief of my goals, tasks, and anything that needs my attention.
      - title: Draft my morning brief
        message: Put together my morning brief.
  app_home:
    home_tab_enabled: true
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  slash_commands:
    - command: /clem
      description: Ask Clementine to do something
      usage_hint: "[what you want done]"
      should_escape: false
  shortcuts:
    - name: Summarize this thread
      type: message
      callback_id: clementine:summarize_thread
      description: Have Clementine summarize this thread
    - name: Turn into a task
      type: message
      callback_id: clementine:make_task
      description: Hand this message to Clementine as a background task
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - assistant:write
      - chat:write
      - im:history
      - im:read
      - im:write
      - channels:history
      - groups:history
      - users:read
      - files:read
      - commands
      - reactions:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
      - assistant_thread_started
      - assistant_thread_context_changed
      - app_home_opened
      - reaction_added
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
`;
