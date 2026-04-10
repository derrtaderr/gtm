/**
 * Clay MCP Server — Bidirectional webhook integration
 *
 * Clay's API model is webhook-based, not REST CRUD. Each Clay table has a
 * unique webhook URL that accepts POSTs to add rows. Clay processes the row
 * asynchronously through configured enrichment columns, then can POST results
 * back to our /webhook/clay endpoint via an HTTP API column at the end of the
 * Clay table.
 *
 * This MCP server handles the OUTBOUND push (agent → Clay).
 * The INBOUND callback (Clay → us) is handled by /webhook/clay in server.ts.
 *
 * Setup in Clay UI:
 * 1. Create a table for enrichment
 * 2. Add a "Monitor Webhook" source — copy the webhook URL into CLAY_WEBHOOK_URL
 * 3. Add enrichment columns (Person enrichment, Company enrichment, etc.)
 * 4. Add a final "HTTP API" column that POSTs to {RAILWAY_URL}/webhook/clay
 *    with the enriched fields + the original lead_id we sent
 *
 * Tools:
 * - clay_push_for_enrichment: Fire-and-forget push of a LinkedIn URL for enrichment
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const clayPushForEnrichment = tool(
  'clay_push_for_enrichment',
  'Push a LinkedIn URL to the Clay enrichment pipeline (FIRE AND FORGET). Returns immediately. Clay processes the row asynchronously and POSTs results back to our /webhook/clay endpoint when complete (typically 30-60 seconds). The agent should NOT wait for results — continue processing the lead with whatever data is available now. The lead will be automatically re-scored when Clay callback arrives. ALWAYS include the lead_id so the callback can correlate back to the right lead.',
  {
    lead_id: z.string().describe('Internal lead UUID — Clay will echo this back in the callback so we can find the lead'),
    linkedin_url: z.string().describe('LinkedIn profile URL to enrich'),
    company_name: z.string().optional().describe('Company name (if known) — assists Clay enrichment'),
    company_domain: z.string().optional().describe('Company domain (if known)'),
    email: z.string().optional().describe('Email address (if known) — assists Clay enrichment'),
  },
  async (args) => {
    const webhookUrl = process.env.CLAY_WEBHOOK_URL;
    if (!webhookUrl) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'skipped',
            reason: 'CLAY_WEBHOOK_URL not configured. Lead will continue without Clay enrichment.',
          }),
        }],
      };
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // Optional auth token (Clay supports a custom header for webhook security)
      if (process.env.CLAY_WEBHOOK_AUTH_TOKEN) {
        headers['Authorization'] = `Bearer ${process.env.CLAY_WEBHOOK_AUTH_TOKEN}`;
      }

      const payload = {
        lead_id: args.lead_id,
        linkedin_url: args.linkedin_url,
        ...(args.company_name && { company_name: args.company_name }),
        ...(args.company_domain && { company_domain: args.company_domain }),
        ...(args.email && { email: args.email }),
      };

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'error',
              error: `Clay webhook returned ${response.status}: ${errorText}`,
            }),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'pushed',
            message: 'Lead pushed to Clay for async enrichment. Results will arrive via /webhook/clay callback (typically 30-60 sec). Continue processing — do not wait.',
            lead_id: args.lead_id,
          }),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'error',
            error: `Clay push failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
        }],
        isError: true,
      };
    }
  }
);

export const clayServer = createSdkMcpServer({
  name: 'clay',
  version: '2.0.0',
  tools: [clayPushForEnrichment],
});
