import { createCloudBrowserClient } from '@clem/chat-engine';
import { api } from './api';
export const cloudBrowser = createCloudBrowserClient(api, '/m/api/cloud-browser');
