import Database from 'better-sqlite3';
import path from 'path';

const HARNESS_DB = path.join(process.env.HOME || '', '.clementine-next/state/harness.db');

function run() {
  try {
    const db = new Database(HARNESS_DB);

    console.log('\n📊 CLEMENTINE LIVE DATA AUDIT');
    console.log('============================\n');

    // 1. Recent workflow/execution runs (last 3 days)
    console.log('1️⃣  WORKFLOW RUNS (Last 3 days)');
    console.log('==============================');
    const runs = db.prepare(`
      SELECT
        s.id, s.kind, s.status, s.title,
        s.created_at, s.updated_at, s.tokens_used,
        json_extract(s.metadata_json, '$.workflowName') as workflow_name,
        COUNT(DISTINCT CASE WHEN e.type = 'turn_started' THEN 1 END) as turns,
        COUNT(DISTINCT CASE WHEN e.type IN ('tool_called', 'tool_returned') THEN 1 END) as tool_events,
        COUNT(DISTINCT CASE WHEN e.type = 'guardrail_tripped' THEN 1 END) as guardrails_tripped,
        COUNT(DISTINCT CASE WHEN e.type = 'stuck_detected' THEN 1 END) as stucks
      FROM sessions s
      LEFT JOIN events e ON s.id = e.session_id
      WHERE s.kind IN ('workflow', 'execution')
        AND s.updated_at >= datetime('now', '-3 days')
      GROUP BY s.id
      ORDER BY s.updated_at DESC
      LIMIT 20
    `).all() as any[];

    for (const run of runs) {
      const status = run.status === 'completed' ? '✅' : run.status === 'failed' ? '❌' : '⏳';
      console.log(`\n${status} ${run.kind.toUpperCase()} — ${run.workflow_name || run.title || 'unnamed'}`);
      console.log(`   ID: ${run.id.substring(0, 12)}...`);
      console.log(`   Status: ${run.status} | Turns: ${run.turns} | Tool calls: ${run.tool_events}`);
      console.log(`   Tokens: ${run.tokens_used} | Guardrails: ${run.guardrails_tripped} | Stucks: ${run.stucks}`);
      console.log(`   Updated: ${new Date(run.updated_at).toLocaleString()}`);
    }

    // 2. Email-related tool calls (the mailbox issue)
    console.log('\n\n2️⃣  EMAIL/MAILBOX TOOL CALLS (Last 24h)');
    console.log('======================================');
    const emailCalls = db.prepare(`
      SELECT
        s.id, s.title, s.channel,
        e.seq, e.turn, e.type,
        json_extract(e.data_json, '$.tool') as tool,
        json_extract(e.data_json, '$.args_json') as args,
        json_extract(e.data_json, '$.success') as success,
        json_extract(e.data_json, '$.error_json') as error,
        e.created_at
      FROM events e
      JOIN sessions s ON e.session_id = s.id
      WHERE e.created_at >= datetime('now', '-1 day')
        AND (json_extract(e.data_json, '$.tool') LIKE '%mail%'
             OR json_extract(e.data_json, '$.tool') LIKE '%Outlook%'
             OR json_extract(e.data_json, '$.tool') LIKE '%Gmail%'
             OR json_extract(e.data_json, '$.tool') LIKE '%send%')
      ORDER BY e.created_at DESC
      LIMIT 50
    `).all() as any[];

    if (emailCalls.length === 0) {
      console.log('(no email tool calls in last 24h)');
    } else {
      for (const call of emailCalls) {
        const icon = call.type === 'tool_called' ? '📤' : call.success ? '✅' : '❌';
        console.log(`\n${icon} ${call.tool} (Turn ${call.turn})`);
        console.log(`   Session: ${call.title || call.id.substring(0, 12)}... (${call.channel || 'desktop'})`);
        console.log(`   Type: ${call.type}`);
        if (call.args) {
          try {
            const args = JSON.parse(call.args);
            // Look for mailbox/from field
            if (args.mailbox) console.log(`   📧 Mailbox: ${args.mailbox}`);
            if (args.from) console.log(`   📧 From: ${args.from}`);
            if (args.to) console.log(`   📧 To: ${args.to}`);
            if (args.subject) console.log(`   📧 Subject: ${args.subject.substring(0, 50)}`);
          } catch { }
        }
        if (call.error) console.log(`   ⚠️  Error: ${call.error.substring(0, 100)}`);
        console.log(`   Time: ${new Date(call.created_at).toLocaleString()}`);
      }
    }

    // 3. Tool call patterns & failures
    console.log('\n\n3️⃣  TOOL CALL PATTERNS (Last 24h)');
    console.log('==================================');
    const toolPatterns = db.prepare(`
      SELECT
        json_extract(e.data_json, '$.tool') as tool,
        COUNT(CASE WHEN e.type = 'tool_called' THEN 1 END) as calls,
        COUNT(CASE WHEN e.type = 'tool_returned' AND json_extract(e.data_json, '$.success') = 0 THEN 1 END) as failures,
        COUNT(CASE WHEN e.type = 'guardrail_tripped' THEN 1 END) as loop_detections,
        COUNT(CASE WHEN e.type = 'stuck_detected' THEN 1 END) as stucks
      FROM events e
      WHERE e.created_at >= datetime('now', '-1 day')
        AND e.type IN ('tool_called', 'tool_returned', 'guardrail_tripped', 'stuck_detected')
      GROUP BY json_extract(e.data_json, '$.tool')
      ORDER BY calls DESC
      LIMIT 30
    `).all() as any[];

    for (const tool of toolPatterns) {
      if (!tool.tool) continue;
      const failRate = tool.calls > 0 ? ((tool.failures / tool.calls) * 100).toFixed(0) : '0';
      const issues = `${tool.failures} fails / ${tool.loop_detections} loops / ${tool.stucks} stucks`;
      console.log(`\n${tool.tool}`);
      console.log(`  Calls: ${tool.calls} | Fail rate: ${failRate}% | Issues: ${issues}`);
    }

    // 4. High-turn conversations (complexity/loops)
    console.log('\n\n4️⃣  HIGH-TURN CONVERSATIONS (Last 3 days)');
    console.log('==========================================');
    const highTurns = db.prepare(`
      SELECT
        s.id, s.title, s.kind, s.status, s.channel,
        COUNT(DISTINCT CASE WHEN e.type = 'turn_started' THEN 1 END) as turns,
        COUNT(DISTINCT CASE WHEN e.type IN ('tool_called', 'tool_returned') THEN 1 END) as tool_events,
        COUNT(DISTINCT CASE WHEN e.type = 'guardrail_tripped' THEN 1 END) as guardrails,
        s.tokens_used,
        s.updated_at
      FROM sessions s
      LEFT JOIN events e ON s.id = e.session_id
      WHERE s.updated_at >= datetime('now', '-3 days')
      GROUP BY s.id
      HAVING turns > 8
      ORDER BY turns DESC
      LIMIT 15
    `).all() as any[];

    if (highTurns.length === 0) {
      console.log('(no high-turn conversations)');
    } else {
      for (const sess of highTurns) {
        const status = sess.status === 'completed' ? '✅' : sess.status === 'failed' ? '❌' : '⏳';
        console.log(`\n${status} ${sess.title || sess.kind || 'unnamed'}`);
        console.log(`   Turns: ${sess.turns} | Tool events: ${sess.tool_events} | Tokens: ${sess.tokens_used}`);
        console.log(`   Guardrails: ${sess.guardrails} | Channel: ${sess.channel || 'desktop'}`);
        console.log(`   Updated: ${new Date(sess.updated_at).toLocaleString()}`);
      }
    }

    // 5. Recent errors & guardrail trips
    console.log('\n\n5️⃣  RECENT ERRORS & GUARDRAIL TRIPS (Last 24h)');
    console.log('==============================================');
    const errors = db.prepare(`
      SELECT
        s.id, s.title,
        e.type, e.turn,
        json_extract(e.data_json, '$.tool') as tool,
        json_extract(e.data_json, '$.reason') as reason,
        json_extract(e.data_json, '$.error_json') as error,
        e.created_at
      FROM events e
      JOIN sessions s ON e.session_id = s.id
      WHERE e.created_at >= datetime('now', '-1 day')
        AND e.type IN ('step_failed', 'guardrail_tripped', 'stuck_detected', 'run_failed')
      ORDER BY e.created_at DESC
      LIMIT 30
    `).all() as any[];

    if (errors.length === 0) {
      console.log('(no recent errors or guardrail trips)');
    } else {
      for (const err of errors) {
        const icon = err.type === 'guardrail_tripped' ? '🔄' : err.type === 'stuck_detected' ? '⏸' : '❌';
        console.log(`\n${icon} ${err.type.toUpperCase()}`);
        console.log(`   Session: ${err.title || err.id.substring(0, 12)}`);
        console.log(`   Turn: ${err.turn} | Tool: ${err.tool || 'N/A'}`);
        if (err.reason) console.log(`   Reason: ${err.reason}`);
        if (err.error) console.log(`   Error: ${err.error.substring(0, 100)}`);
        console.log(`   Time: ${new Date(err.created_at).toLocaleString()}`);
      }
    }

    // 6. Approval requests (memory of instructions)
    console.log('\n\n6️⃣  PENDING APPROVALS (Current)');
    console.log('================================');
    const approvals = db.prepare(`
      SELECT
        approval_id, session_id, tool, subject, status,
        requested_at
      FROM pending_approvals
      WHERE status IN ('pending', 'resolved')
      ORDER BY requested_at DESC
      LIMIT 10
    `).all() as any[];

    if (approvals.length === 0) {
      console.log('(no pending approvals)');
    } else {
      for (const app of approvals) {
        const icon = app.status === 'pending' ? '⏳' : '✅';
        console.log(`\n${icon} ${app.tool}`);
        console.log(`   Subject: ${app.subject}`);
        console.log(`   Status: ${app.status}`);
        console.log(`   Requested: ${new Date(app.requested_at).toLocaleString()}`);
      }
    }

    db.close();
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

run();
