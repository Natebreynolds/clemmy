import Database from 'better-sqlite3';
import path from 'path';

const HARNESS_DB = path.join(process.env.HOME || '', '.clementine-next/state/harness.db');

function run() {
  try {
    const db = new Database(HARNESS_DB);

    console.log('\n🔍 DEEP DIVE: FAILURES & MAILBOX ISSUE');
    console.log('======================================\n');

    // 1. Failed workflow details
    console.log('1️⃣  FAILED OUTLOOK-TRIAGE RUNS (Detailed)');
    console.log('==========================================');
    const failedRuns = db.prepare(`
      SELECT
        s.id, s.title, s.status, s.created_at, s.updated_at,
        e.turn, e.type, e.seq,
        json_extract(e.data_json, '$.tool') as tool,
        json_extract(e.data_json, '$.error_json') as error,
        json_extract(e.data_json, '$.message') as message
      FROM sessions s
      JOIN events e ON s.id = e.session_id
      WHERE s.kind = 'workflow'
        AND json_extract(s.metadata_json, '$.workflowName') = 'outlook-triage-hourly'
        AND s.status = 'failed'
        AND s.updated_at >= datetime('now', '-2 days')
      ORDER BY s.updated_at DESC, e.seq DESC
      LIMIT 100
    `).all() as any[];

    for (const run of failedRuns) {
      console.log(`\n❌ ${run.title}`);
      console.log(`   ID: ${run.id.substring(0, 20)}...`);
      console.log(`   Failed at: ${new Date(run.updated_at).toLocaleString()}`);
      console.log(`   Turn ${run.turn}: ${run.type}`);
      if (run.tool) console.log(`   Tool: ${run.tool}`);
      if (run.error) console.log(`   Error: ${run.error.substring(0, 200)}`);
      if (run.message) console.log(`   Message: ${run.message}`);
    }

    // 2. Guardrail trip details (dedup the "% of effective limit" noise)
    console.log('\n\n2️⃣  GUARDRAIL TRIPS (Excluding % budget warnings)');
    console.log('==================================================');
    const guardrails = db.prepare(`
      SELECT
        s.id, s.title, s.kind,
        e.type, e.turn,
        json_extract(e.data_json, '$.reason') as reason,
        json_extract(e.data_json, '$.tool') as tool,
        COUNT(*) as count,
        MAX(e.created_at) as latest
      FROM events e
      JOIN sessions s ON e.session_id = s.id
      WHERE e.created_at >= datetime('now', '-1 day')
        AND e.type = 'guardrail_tripped'
        AND json_extract(e.data_json, '$.reason') NOT LIKE '%of effective limit%'
      GROUP BY json_extract(e.data_json, '$.reason')
      ORDER BY latest DESC
    `).all() as any[];

    if (guardrails.length === 0) {
      console.log('(all guardrail trips are budget-related, no real loops)');
    } else {
      for (const grd of guardrails) {
        console.log(`\n🔄 ${grd.reason}`);
        console.log(`   Count: ${grd.count} times`);
        console.log(`   Latest: ${new Date(grd.latest).toLocaleString()}`);
        console.log(`   Sessions affected: ${grd.id.substring(0, 12)}...`);
      }
    }

    // 3. Email history (search backwards further)
    console.log('\n\n3️⃣  EMAIL/SEND TOOL HISTORY (Last 7 days)');
    console.log('=========================================');
    const emailHistory = db.prepare(`
      SELECT
        s.id, s.title, s.channel,
        e.seq, e.turn, e.type, e.created_at,
        json_extract(e.data_json, '$.tool') as tool,
        json_extract(e.data_json, '$.args_json') as args,
        json_extract(e.data_json, '$.success') as success
      FROM events e
      JOIN sessions s ON e.session_id = s.id
      WHERE e.created_at >= datetime('now', '-7 days')
        AND (json_extract(e.data_json, '$.tool') LIKE '%send%'
             OR json_extract(e.data_json, '$.tool') LIKE '%mail%'
             OR json_extract(e.data_json, '$.tool') LIKE '%outlook%'
             OR json_extract(e.data_json, '$.args_json') LIKE '%mailbox%'
             OR json_extract(e.data_json, '$.args_json') LIKE '%from%')
      ORDER BY e.created_at DESC
      LIMIT 50
    `).all() as any[];

    if (emailHistory.length === 0) {
      console.log('(no email/send/mailbox tool calls in last 7 days)');
    } else {
      for (const evt of emailHistory) {
        const icon = evt.type === 'tool_called' ? '📤' : evt.success ? '✅' : '❌';
        console.log(`\n${icon} ${evt.tool}`);
        console.log(`   Session: ${evt.title || evt.id.substring(0, 12)}`);
        console.log(`   Type: ${evt.type} | Turn: ${evt.turn}`);
        if (evt.args) {
          try {
            const args = JSON.parse(evt.args);
            const relevant = ['mailbox', 'from', 'account', 'sender', 'to', 'subject'].reduce((acc: any, key) => {
              if (args[key]) acc[key] = args[key];
              return acc;
            }, {});
            if (Object.keys(relevant).length > 0) {
              console.log(`   Args: ${JSON.stringify(relevant)}`);
            }
          } catch { }
        }
        console.log(`   Time: ${new Date(evt.created_at).toLocaleString()}`);
      }
    }

    // 4. Workspace data - memory recall patterns
    console.log('\n\n4️⃣  MEMORY RECALL PATTERNS (Last 24h)');
    console.log('=====================================');
    const memoryRecalls = db.prepare(`
      SELECT
        json_extract(e.data_json, '$.tool') as tool,
        COUNT(*) as calls,
        COUNT(DISTINCT e.session_id) as sessions_using
      FROM events e
      WHERE e.created_at >= datetime('now', '-1 day')
        AND json_extract(e.data_json, '$.tool') IN ('tool_choice_recall', 'turn_memory_primer', 'memory_search')
      GROUP BY json_extract(e.data_json, '$.tool')
    `).all() as any[];

    if (memoryRecalls.length === 0) {
      console.log('(no memory recall events)');
    } else {
      for (const recall of memoryRecalls) {
        console.log(`\n${recall.tool}`);
        console.log(`   Total calls: ${recall.calls}`);
        console.log(`   Sessions: ${recall.sessions_using}`);
      }
    }

    // 5. Check for instruction violations
    console.log('\n\n5️⃣  INSTRUCTION ADHERENCE CHECK');
    console.log('================================');
    const instructions = db.prepare(`
      SELECT
        json_extract(e.data_json, '$.key') as instruction_key,
        COUNT(*) as violations,
        GROUP_CONCAT(DISTINCT e.session_id, ', ') as sessions
      FROM events e
      WHERE e.created_at >= datetime('now', '-3 days')
        AND e.type = 'instruction_violation'
      GROUP BY json_extract(e.data_json, '$.key')
    `).all() as any[];

    if (instructions.length === 0) {
      console.log('(no instruction violations recorded)');
    } else {
      for (const instr of instructions) {
        console.log(`\n⚠️  ${instr.instruction_key}: ${instr.violations} violations`);
      }
    }

    // 6. Summary: Token usage & efficiency
    console.log('\n\n6️⃣  EFFICIENCY SUMMARY');
    console.log('=======================');
    const efficiency = db.prepare(`
      SELECT
        SUM(s.tokens_used) as total_tokens,
        COUNT(DISTINCT s.id) as total_sessions,
        COUNT(DISTINCT CASE WHEN s.status = 'completed' THEN 1 END) as completed,
        COUNT(DISTINCT CASE WHEN s.status = 'failed' THEN 1 END) as failed,
        AVG(CASE WHEN s.tokens_used > 0 THEN s.tokens_used ELSE NULL END) as avg_tokens_per_session,
        COUNT(DISTINCT CASE WHEN s.kind = 'workflow' THEN 1 END) as workflows,
        COUNT(DISTINCT CASE WHEN s.kind = 'chat' THEN 1 END) as chats
      FROM sessions s
      WHERE s.updated_at >= datetime('now', '-1 day')
    `).all() as any[];

    for (const stats of efficiency) {
      console.log(`\nLast 24h Summary:`);
      console.log(`  Total tokens: ${stats.total_tokens || 0}`);
      console.log(`  Sessions: ${stats.total_sessions} (${stats.completed} completed, ${stats.failed} failed)`);
      console.log(`  Workflows: ${stats.workflows} | Chats: ${stats.chats}`);
      console.log(`  Avg tokens/session: ${stats.avg_tokens_per_session ? stats.avg_tokens_per_session.toFixed(0) : 'N/A'}`);
      console.log(`  Success rate: ${stats.total_sessions > 0 ? ((stats.completed / stats.total_sessions) * 100).toFixed(1) : '0'}%`);
    }

    db.close();
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

run();
