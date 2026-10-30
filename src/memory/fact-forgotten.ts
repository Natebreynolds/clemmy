/** How a forgotten fact's last validity period closes. Decay and replacement
 *  close it as `deactivated` / `superseded`; only a forget closes it this way,
 *  and only this way keeps it out of archive recall and earn-back. */
export const FORGOTTEN_CLOSE_REASON = 'forgotten';

/** SQL: true when fact `<alias>.id` was forgotten, not decayed or replaced. */
export function factForgottenSql(alias: string): string {
  return `COALESCE((SELECT closed_reason FROM fact_validity_intervals WHERE fact_id = ${alias}.id
    ORDER BY valid_from DESC, id DESC LIMIT 1), '') = '${FORGOTTEN_CLOSE_REASON}'`;
}
