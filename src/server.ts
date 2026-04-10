/**
 * Magnetiz GTM Agent System V2 — Server Entry Point
 *
 * Three responsibilities:
 * 1. POST /webhook/rb2b — Triggers GTM pipeline (webhook mode)
 * 2. Cron: daily 9am ET — Triggers GoExtrovert push/pull sync
 * 3. Cron: Mon 8am ET — Triggers ads sync, re-scoring, metrics
 */

import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import { parseRB2BWebhook, validateWebhookSecret } from './utils/webhook-parser.js';
import { runGTMPipeline } from './agents/gtm-orchestrator.js';

const app = express();
app.use(express.json());

// ============================================================
// Health Check
// ============================================================

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'magnetiz-gtm',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// Webhook: RB2B Signal Ingestion
// ============================================================

app.post('/webhook/rb2b', async (req, res) => {
  // Validate webhook secret if configured
  const secret = process.env.RB2B_WEBHOOK_SECRET;
  if (secret && !validateWebhookSecret(req.headers['x-webhook-secret'] as string, secret)) {
    console.warn('[Webhook] Invalid webhook secret');
    res.status(401).json({ error: 'Invalid webhook secret' });
    return;
  }

  // Log the raw body so we can see RB2B's actual field names
  console.log('[Webhook] RB2B raw payload:', JSON.stringify(req.body));

  // Parse the RB2B payload
  const signal = parseRB2BWebhook(req.body);
  if (!signal) {
    console.warn('[Webhook] Invalid RB2B payload — missing linkedin_url. Received fields:', Object.keys(req.body || {}));
    res.status(400).json({
      error: 'Invalid payload: linkedin_url is required',
      received_fields: Object.keys(req.body || {}),
    });
    return;
  }

  console.log(`[Webhook] Received signal for ${signal.first_name ?? 'Unknown'} ${signal.last_name ?? ''} (${signal.linkedin_url})`);

  // Respond immediately — process async
  res.status(200).json({ received: true, linkedin_url: signal.linkedin_url });

  // Process through the GTM pipeline asynchronously
  try {
    await runGTMPipeline('webhook', signal);
  } catch (error) {
    console.error('[Webhook] Pipeline error:', error instanceof Error ? error.message : error);
  }
});

// ============================================================
// Webhook: GoExtrovert (comment threshold reached)
// ============================================================

app.post('/webhook/goextrovert', async (req, res) => {
  // GoExtrovert sends a webhook when a prospect hits the comment threshold.
  // The payload is custom-configured in GoExtrovert with {{linkedinUrl}} variable.
  // Expected format: { "prospect_linkedin": "{{linkedinUrl}}", "source": "extrovert" }

  const linkedinUrl = req.body?.prospect_linkedin || req.body?.linkedinUrl || req.body?.linkedin_url;

  if (!linkedinUrl) {
    console.warn('[Webhook] GoExtrovert webhook missing LinkedIn URL');
    res.status(400).json({ error: 'Missing LinkedIn URL' });
    return;
  }

  console.log(`[Webhook] GoExtrovert threshold reached for: ${linkedinUrl}`);
  res.status(200).json({ received: true });

  // Update the lead status to 'connected' (they've been warmed by engagement)
  // This runs the orchestrator which will update the database
  try {
    await runGTMPipeline('webhook', {
      LinkedInUrl: linkedinUrl,
      source: 'goextrovert_threshold',
    });
  } catch (error) {
    console.error('[Webhook] GoExtrovert processing error:', error instanceof Error ? error.message : error);
  }
});

// ============================================================
// Cron Jobs
// ============================================================

// Daily: GoExtrovert sync (push new 75+ leads + pull status updates)
// 9am ET every day
cron.schedule('0 9 * * *', async () => {
  console.log('[Cron] Daily GoExtrovert sync started');
  try {
    await runGTMPipeline('daily_goextrovert_sync');
    console.log('[Cron] Daily GoExtrovert sync completed');
  } catch (error) {
    console.error('[Cron] Daily sync error:', error instanceof Error ? error.message : error);
  }
}, { timezone: 'America/New_York' });

// Weekly: Ads sync, re-scoring, metrics (Monday 8am ET)
cron.schedule('0 8 * * 1', async () => {
  console.log('[Cron] Weekly sync started');
  try {
    await runGTMPipeline('weekly_sync');
    console.log('[Cron] Weekly sync completed');
  } catch (error) {
    console.error('[Cron] Weekly sync error:', error instanceof Error ? error.message : error);
  }
}, { timezone: 'America/New_York' });

// ============================================================
// Start Server
// ============================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`[Server] Magnetiz GTM Agent System V2 running on port ${PORT}`);
  console.log(`[Server] Endpoints:`);
  console.log(`  GET  /health`);
  console.log(`  POST /webhook/rb2b`);
  console.log(`  POST /webhook/goextrovert`);
  console.log(`[Server] Cron jobs:`);
  console.log(`  Daily 9am ET  — GoExtrovert push/pull sync`);
  console.log(`  Weekly Mon 8am ET — Ads sync, re-scoring, metrics`);
});
