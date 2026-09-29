import { approvalReview, approvalFieldText, type ApprovalPreview } from '@clem/chat-engine';

const label = (name: string) => (({ attendees_info: 'Invite', time_zone: 'Time zone', is_all_day: 'All day', show_as: 'Calendar availability', body: 'Description' } as Record<string, string>)[name] ?? name.replace(/_/g, ' '));

export function ApprovalReview({ preview }: { preview: ApprovalPreview }) {
  const review = approvalReview(preview);
  if (!review) return null;
  const fields = (values: ApprovalPreview['fields']) => <dl className="approval-review-fields">{values.map((field, index) => <div key={index}>
    <dt>{label(field.name)}</dt><dd>{approvalFieldText(field)}</dd>
  </div>)}</dl>;
  return <section className="approval-review" aria-label="Prepared actions">
    <p className="approval-review-scope">Approve all {review.items.length} listed actions. Check the dates, times and recipients. Reply with changes before approving.</p>
    {fields(review.common.filter(field => !(review.items.every(item => item.when) && field.name === 'is_all_day')))}
    <ol className="approval-review-list">{review.items.map((item, index) => <li key={index}>
      <p className="approval-review-title">{item.title}</p>
      {item.when && <p className="approval-review-when">{item.when}</p>}
      {fields(item.fields)}
      {item.check && item.check.status !== 'clear' && <p className="approval-review-warning" role="note">{item.check.status === 'conflicts'
        ? `Standing-rule conflicts: ${item.check.conflicts?.join('; ') ?? 'Review needed'}`
        : 'Standing-rule check unavailable.'}</p>}
      <details><summary>{item.when ? 'Description & exact details' : 'Exact details'}</summary>{fields(item.exact)}</details>
    </li>)}</ol>
    {review.items.every(item => item.check?.status === 'clear') && <p className="approval-review-scope">Standing rules checked for all {review.items.length} actions — no conflicts found.</p>}
  </section>;
}
