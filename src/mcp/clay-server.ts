/**
 * Clay MCP Server — Custom in-process MCP server for Clay API enrichment
 *
 * Tools:
 * - clay_enrich_person: Enrich a person by LinkedIn URL or email
 * - clay_enrich_company: Enrich a company by name or domain
 * - clay_check_quota: Check remaining free tier quota
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const CLAY_API_BASE = 'https://api.clay.com/v1';

function getClayHeaders(): HeadersInit {
  return {
    'Authorization': `Bearer ${process.env.CLAY_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

const clayEnrichPerson = tool(
  'clay_enrich_person',
  'Enrich a person record by LinkedIn URL or email via Clay. Returns title, company, industry, location, and other available fields.',
  {
    linkedin_url: z.string().optional().describe('LinkedIn profile URL'),
    email: z.string().optional().describe('Work email address'),
  },
  async (args) => {
    try {
      if (!args.linkedin_url && !args.email) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either linkedin_url or email is required' }) }], isError: true };
      }

      const tableId = process.env.CLAY_TABLE_ID;
      if (!tableId) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CLAY_TABLE_ID not configured' }) }], isError: true };
      }

      const response = await fetch(`${CLAY_API_BASE}/tables/${tableId}/rows`, {
        method: 'POST',
        headers: getClayHeaders(),
        body: JSON.stringify({
          data: {
            ...(args.linkedin_url && { linkedin_url: args.linkedin_url }),
            ...(args.email && { email: args.email }),
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Clay API error ${response.status}: ${errorText}` }) }], isError: true };
      }

      const result = await response.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Clay enrich_person failed: ${error instanceof Error ? error.message : String(error)}` }) }], isError: true };
    }
  }
);

const clayEnrichCompany = tool(
  'clay_enrich_company',
  'Enrich a company by name or domain via Clay. Returns industry, employee count, revenue range, website, and other firmographic data.',
  {
    company_name: z.string().optional().describe('Company name'),
    domain: z.string().optional().describe('Company website domain'),
  },
  async (args) => {
    try {
      if (!args.company_name && !args.domain) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either company_name or domain is required' }) }], isError: true };
      }

      const tableId = process.env.CLAY_TABLE_ID;
      if (!tableId) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CLAY_TABLE_ID not configured' }) }], isError: true };
      }

      const response = await fetch(`${CLAY_API_BASE}/tables/${tableId}/rows`, {
        method: 'POST',
        headers: getClayHeaders(),
        body: JSON.stringify({
          data: {
            ...(args.company_name && { company_name: args.company_name }),
            ...(args.domain && { domain: args.domain }),
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Clay API error ${response.status}: ${errorText}` }) }], isError: true };
      }

      const result = await response.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Clay enrich_company failed: ${error instanceof Error ? error.message : String(error)}` }) }], isError: true };
    }
  }
);

const clayCheckQuota = tool(
  'clay_check_quota',
  'Check remaining Clay free tier quota. Free tier allows 200 rows per table. Returns remaining row count.',
  {},
  async () => {
    try {
      const tableId = process.env.CLAY_TABLE_ID;
      if (!tableId) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CLAY_TABLE_ID not configured' }) }], isError: true };
      }

      const response = await fetch(`${CLAY_API_BASE}/tables/${tableId}`, {
        method: 'GET',
        headers: getClayHeaders(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Clay API error ${response.status}: ${errorText}` }) }], isError: true };
      }

      const table = await response.json();
      const rowCount = table.row_count ?? 0;
      const maxRows = 200; // Free tier limit
      const remaining = Math.max(0, maxRows - rowCount);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            remaining,
            used: rowCount,
            total: maxRows,
            quota_exceeded: remaining === 0,
          }),
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Clay check_quota failed: ${error instanceof Error ? error.message : String(error)}` }) }], isError: true };
    }
  }
);

export const clayServer = createSdkMcpServer({
  name: 'clay',
  version: '1.0.0',
  tools: [clayEnrichPerson, clayEnrichCompany, clayCheckQuota],
});
