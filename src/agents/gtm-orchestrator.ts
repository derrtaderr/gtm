/**
 * GTM Orchestrator — Main agent that coordinates the signal-to-pipeline loop.
 *
 * Three trigger modes:
 * 1. webhook — RB2B signal → Signal+Enrichment Agent → ICP Scorer → Route
 * 2. daily_goextrovert_sync — Push 75+ leads to GoExtrovert, pull status updates
 * 3. weekly_sync — Ads sync, re-scoring monitoring leads, populate metrics
 */

import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { databaseServer } from '../mcp/database-server.js';
import { clayServer } from '../mcp/clay-server.js';
import { proxycurlServer } from '../mcp/proxycurl-server.js';
import { goextrovertServer } from '../mcp/goextrovert-server.js';
import { linkedinAdsServer } from '../mcp/linkedin-ads.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load system prompts from markdown files
const orchestratorPrompt = readFileSync(join(__dirname, '../prompts/orchestrator.md'), 'utf-8');
const signalEnrichmentPrompt = readFileSync(join(__dirname, '../prompts/signal-enrichment.md'), 'utf-8');

// Load scorer prompt from markdown file (full prompt, Sprint 2)
const scorerPrompt = readFileSync(join(__dirname, '../prompts/scorer.md'), 'utf-8');

/**
 * Run the GTM pipeline for a given trigger.
 */
export async function runGTMPipeline(
  triggerType: 'webhook' | 'daily_goextrovert_sync' | 'weekly_sync' | 'clay_callback',
  payload?: unknown
): Promise<SDKResultMessage | undefined> {
  const prompt = buildPrompt(triggerType, payload);

  console.log(`[GTM] Pipeline triggered: ${triggerType}`);

  let result: SDKResultMessage | undefined;

  try {
    for await (const message of query({
      prompt,
      options: {
        systemPrompt: orchestratorPrompt,
        model: 'sonnet',
        maxTurns: 25,
        persistSession: false,
        permissionMode: 'bypassPermissions',
        // Explicitly use Node runtime — auto-detection can fail in slim containers
        executable: 'node',
        // Capture stderr from the Claude Code subprocess for debugging
        stderr: (data: string) => {
          console.error(`[GTM:stderr] ${data.trimEnd()}`);
        },
        mcpServers: {
          database: databaseServer,
          clay: clayServer,
          proxycurl: proxycurlServer,
          goextrovert: goextrovertServer,
          'linkedin-ads': linkedinAdsServer,
        },
        agents: {
          'signal-enrichment': {
            description: 'Processes RB2B webhook signals: deduplicates against existing leads, stores new signals, and enriches leads via Clay/Proxycurl waterfall enrichment. Use this agent when you receive a webhook trigger with an RB2B payload.',
            prompt: signalEnrichmentPrompt,
            model: 'sonnet',
            maxTurns: 15,
          },
          'icp-scorer': {
            description: 'Runs the 100-point ICP scoring model against enriched lead data and determines 3-tier routing (outreach 75+, retarget 50-74, monitoring 0-49). Use this agent after a lead has been enriched.',
            prompt: scorerPrompt,
            model: 'sonnet',
            maxTurns: 10,
          },
        },
        allowedTools: [
          'Agent',
          'mcp__database__db_query',
          'mcp__clay__clay_push_for_enrichment',
          'mcp__proxycurl__proxycurl_person_profile',
          'mcp__proxycurl__proxycurl_company_profile',
          'mcp__goextrovert__goextrovert_add_prospect',
          'mcp__goextrovert__goextrovert_get_prospects',
          'mcp__goextrovert__goextrovert_remove_prospect',
          'mcp__linkedin-ads__linkedin_ads_sync_audience',
          'mcp__linkedin-ads__linkedin_ads_get_campaigns',
          'mcp__linkedin-ads__linkedin_ads_update_budget',
          'mcp__linkedin-ads__linkedin_ads_get_analytics',
        ],
      },
    })) {
      handleMessage(message);

      if (message.type === 'result') {
        result = message;
      }
    }
  } catch (error) {
    console.error(`[GTM] Pipeline error:`, error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
      console.error(`[GTM] Stack:`, error.stack);
    }
    // Surface any underlying cause (Node 16+ supports error.cause)
    if (error instanceof Error && 'cause' in error && error.cause) {
      console.error(`[GTM] Cause:`, error.cause);
    }
  }

  return result;
}

/**
 * Build the user prompt based on trigger type.
 */
function buildPrompt(triggerType: string, payload?: unknown): string {
  switch (triggerType) {
    case 'webhook':
      return [
        'New RB2B webhook received. Process this signal through the full pipeline:',
        '1. Delegate to the signal-enrichment agent with the payload below',
        '2. Once enriched, delegate to the icp-scorer agent with the returned lead_id',
        '3. Report the final score and routing decision',
        '',
        'RB2B Payload:',
        JSON.stringify(payload, null, 2),
      ].join('\n');

    case 'daily_goextrovert_sync':
      return [
        'Daily GoExtrovert sync triggered (9am ET). Execute the following:',
        '',
        '1. PUSH: Query leads where icp_score >= 75 AND goextrovert_synced = false AND paused = false AND manual_override = false.',
        `   For each lead, call goextrovert_add_prospect with their LinkedIn URL, campaign ID "${process.env.GOEXTROVERT_CAMPAIGN_ID || 'NOT_CONFIGURED'}", and list ID "${process.env.GOEXTROVERT_LIST_ID || 'NOT_CONFIGURED'}".`,
        '   Update goextrovert_synced = true on success. Log each push to agent_activity_log.',
        '',
        '2. PULL: Call goextrovert_get_prospects for the campaign to get current engagement stats.',
        '   Update goextrovert_sync table with latest stats. Log any status changes.',
        '',
        'Report: how many leads pushed, how many statuses updated.',
      ].join('\n');

    case 'weekly_sync':
      return [
        'Weekly sync triggered (Monday 8am ET). Execute the following:',
        '',
        '1. RE-SCORE: Find monitoring leads with new signals since their last score:',
        '   SELECT l.id FROM leads l JOIN icp_scores s ON l.id = s.lead_id',
        '   WHERE l.status = \'monitoring\' AND EXISTS (SELECT 1 FROM signals WHERE lead_id = l.id AND created_at > s.created_at)',
        '   For each, delegate to the icp-scorer agent for re-scoring.',
        '',
        '2. ADS SYNC: Query retarget_audience where synced_to_linkedin = false.',
        '   For each batch of leads, get their company_name from the leads table.',
        '   Call linkedin_ads_sync_audience with the company names to update the matched audience.',
        '   Update retarget_audience: synced_to_linkedin = true, last_synced = now().',
        '   Log added_to_ad_audience to agent_activity_log for each lead.',
        '',
        '3. ADS ANALYTICS: Call linkedin_ads_get_analytics for the past 7 days.',
        '   Log a summary of impressions, clicks, and spend to agent_activity_log.',
        '',
        '4. METRICS: Call fn_populate_daily_metrics() for any days not yet aggregated:',
        '   SELECT fn_populate_daily_metrics(d::date) FROM generate_series(',
        '     (SELECT COALESCE(MAX(date), CURRENT_DATE - 7) FROM daily_metrics),',
        '     CURRENT_DATE, \'1 day\'::interval) d;',
        '',
        '5. Report: how many leads re-scored, how many graduated, audience synced, metrics populated.',
      ].join('\n');

    case 'clay_callback':
      return [
        'Clay enrichment callback received. The lead was previously pushed to Clay for async enrichment, and Clay has now POSTed back the enriched data.',
        '',
        'Process this callback in 5 steps:',
        '',
        '1. FIND THE LEAD: Use the lead_id from the payload to find the lead:',
        '   SELECT id, status, first_name, last_name, title, company_name, company_domain, email FROM leads WHERE id = $1',
        '   (If lead_id is missing, fall back to looking up by linkedin_url)',
        '   If lead.manual_override = true, SKIP entirely.',
        '',
        '2. UPDATE LEAD COLUMNS with newly enriched data (use COALESCE to preserve existing values where the new value is null/empty):',
        '   UPDATE leads SET',
        '     first_name = COALESCE(NULLIF($2, \'\'), first_name),',
        '     last_name = COALESCE(NULLIF($3, \'\'), last_name),',
        '     email = COALESCE(NULLIF($4, \'\'), email),',
        '     title = COALESCE(NULLIF($5, \'\'), title),',
        '     company_name = COALESCE(NULLIF($6, \'\'), company_name),',
        '     company_domain = COALESCE(NULLIF($7, \'\'), company_domain),',
        '     location = COALESCE(NULLIF($8, \'\'), location),',
        '     coverage_score = $9,',
        '     status = \'enriched\',',
        '     last_agent_action = \'Enriched via Clay (async)\',',
        '     last_agent_action_at = now(),',
        '     updated_at = now()',
        '   WHERE id = $1;',
        '',
        '3. MERGE FIRMOGRAPHIC DATA into the most recent signal\'s raw_data JSONB:',
        '   UPDATE signals SET raw_data = raw_data || $2::jsonb',
        '   WHERE lead_id = $1 AND id = (SELECT id FROM signals WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1);',
        '   The merged JSONB should include any new fields from Clay: industry, employee_count, revenue_range, recent_posts, linkedin_activity, etc.',
        '',
        '4. LOG enrichment_completed to agent_activity_log:',
        '   INSERT INTO agent_activity_log (lead_id, agent_name, action_type, action_detail, status)',
        '   VALUES ($1, \'Enrichment Agent\', \'enrichment_completed\', $2::jsonb, \'success\');',
        '   action_detail should include: { "source": "clay", "trigger": "clay_callback", "fields_added": [...] }',
        '',
        '5. RE-SCORE: Delegate to the icp-scorer agent to re-score this lead with the new data. The scorer will detect this is a re-score (existing icp_scores row), update the score, and route accordingly. If the lead crosses the 75 threshold, it will be queued for GoExtrovert.',
        '',
        'Clay payload (the data Clay sent back):',
        JSON.stringify(payload, null, 2),
      ].join('\n');

    default:
      return `Unknown trigger type: ${triggerType}. No action taken.`;
  }
}

/**
 * Handle streamed messages from the agent SDK.
 */
function handleMessage(message: SDKMessage): void {
  switch (message.type) {
    case 'system':
      if ('session_id' in message) {
        console.log(`[GTM] Session: ${message.session_id}`);
      }
      // Log MCP server connection status on init
      if ('subtype' in message && message.subtype === 'init' && 'mcp_servers' in message) {
        const servers = (message as any).mcp_servers;
        if (Array.isArray(servers)) {
          for (const server of servers) {
            if (server.status !== 'connected') {
              console.warn(`[GTM] MCP server "${server.name}" status: ${server.status}`);
            }
          }
        }
      }
      break;

    case 'assistant':
      // Log assistant responses (truncated for readability)
      if (message.message?.content) {
        const text = message.message.content
          .filter((block) => block.type === 'text')
          .map((block) => (block as { type: 'text'; text: string }).text)
          .join('\n');
        if (text) {
          console.log(`[GTM] Assistant: ${text.slice(0, 300)}${text.length > 300 ? '...' : ''}`);
        }
      }
      break;

    case 'result':
      if (message.subtype === 'success') {
        console.log(`[GTM] Pipeline completed successfully`);
        // Log cost/usage if available
        logUsage(message);
      } else {
        console.error(`[GTM] Pipeline ended: ${message.subtype}`, 'error' in message ? message.error : '');
        if (message.subtype === 'error_max_turns') {
          console.error(`[GTM] Hit maxTurns limit — agent may need more turns or the task is too complex`);
        }
      }
      break;
  }
}

/**
 * Log token usage and estimated cost from the result message.
 * Sonnet pricing: ~$3/M input, ~$15/M output tokens.
 */
function logUsage(message: SDKResultMessage): void {
  if (!('usage' in message)) return;
  const usage = (message as any).usage;
  if (!usage) return;

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;

  // Estimate cost (Claude Sonnet pricing)
  const estimatedCost = (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;

  console.log(`[GTM] Usage: ${inputTokens} input + ${outputTokens} output tokens (~$${estimatedCost.toFixed(4)})`);

  if (estimatedCost > 0.50) {
    console.warn(`[GTM] COST WARNING: Single pipeline run cost $${estimatedCost.toFixed(4)} — review agent efficiency`);
  }
}
