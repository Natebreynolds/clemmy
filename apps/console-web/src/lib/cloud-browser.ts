import { createCloudBrowserClient } from '@clem/chat-engine';
import { api } from './api';
export const cloudBrowser = createCloudBrowserClient(api, '/api/console/cloud-browser');
