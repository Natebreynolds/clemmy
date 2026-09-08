import { api, apiGet } from './api';
import { readCompletionReviewResponse } from '../../../../packages/chat-engine/src/completion-review';

const PATH = '/api/console/settings/completion-review';

export async function getCompletionReview() {
  return readCompletionReviewResponse(await apiGet<unknown>(PATH));
}

export async function setCompletionReview(enabled: boolean) {
  return readCompletionReviewResponse(await api<unknown>(PATH, {
    method: 'PATCH', body: JSON.stringify({ enabled }),
  }));
}
