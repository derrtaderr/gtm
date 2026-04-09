/**
 * LinkedIn Ads MCP Server — Custom in-process MCP server for LinkedIn Marketing API v2
 *
 * Handles retarget audience sync, campaign management, and analytics.
 * Requires a LinkedIn Developer App with Marketing API access and OAuth2 token
 * with rw_ads and r_ads_reporting scopes.
 *
 * API: https://learn.microsoft.com/en-us/linkedin/marketing/
 * Rate limit: 100 requests/day for most endpoints
 *
 * Tools:
 * - linkedin_ads_sync_audience: Upload/update matched audience from retarget_audience table
 * - linkedin_ads_get_campaigns: List active campaigns with performance metrics
 * - linkedin_ads_update_budget: Adjust campaign budget
 * - linkedin_ads_get_analytics: Pull campaign analytics for a date range
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const LINKEDIN_API_BASE = 'https://api.linkedin.com/v2';
const LINKEDIN_ADS_BASE = 'https://api.linkedin.com/rest';

function getLinkedInHeaders(restApi = false): HeadersInit {
  const headers: HeadersInit = {
    'Authorization': `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
  if (restApi) {
    // LinkedIn REST API requires versioned header
    (headers as Record<string, string>)['LinkedIn-Version'] = '202404';
    (headers as Record<string, string>)['X-Restli-Protocol-Version'] = '2.0.0';
  }
  return headers;
}

function getAdAccountUrn(): string {
  return `urn:li:sponsoredAccount:${process.env.LINKEDIN_AD_ACCOUNT_ID}`;
}

const linkedinAdsSyncAudience = tool(
  'linkedin_ads_sync_audience',
  'Upload or update a matched audience list on LinkedIn Campaign Manager from the retarget_audience table. Accepts an array of company names or email addresses to create a Matched Audience for ad targeting. Returns the audience ID.',
  {
    audience_name: z.string().describe('Name for the matched audience (e.g., "Magnetiz Retarget - Warm")'),
    audience_id: z.string().optional().describe('Existing audience ID to update. Omit to create new.'),
    companies: z.array(z.string()).optional().describe('Array of company names to match'),
    emails: z.array(z.string()).optional().describe('Array of email addresses to match (SHA256 hashed recommended)'),
  },
  async (args) => {
    try {
      if (!args.companies?.length && !args.emails?.length) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either companies or emails array is required' }) }], isError: true };
      }

      const adAccountUrn = getAdAccountUrn();

      if (args.audience_id) {
        // Update existing audience — add users
        const entities = args.emails
          ? args.emails.map(email => ({ userIds: [{ idType: 'SHA256_EMAIL', idValue: email }] }))
          : args.companies!.map(company => ({ organizationName: company }));

        const response = await fetch(`${LINKEDIN_ADS_BASE}/dmpSegments/${args.audience_id}/users`, {
          method: 'POST',
          headers: getLinkedInHeaders(true),
          body: JSON.stringify({ elements: entities }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `LinkedIn API error ${response.status}: ${errorText}` }) }], isError: true };
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'updated', audience_id: args.audience_id, entities_added: entities.length }) }] };
      } else {
        // Create new matched audience
        const audienceType = args.emails ? 'USER_UPLOADED_EMAIL' : 'USER_UPLOADED_COMPANY';

        const response = await fetch(`${LINKEDIN_ADS_BASE}/dmpSegments`, {
          method: 'POST',
          headers: getLinkedInHeaders(true),
          body: JSON.stringify({
            name: args.audience_name,
            account: adAccountUrn,
            type: audienceType,
            destinations: [{ destination: adAccountUrn }],
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `LinkedIn API error ${response.status}: ${errorText}` }) }], isError: true };
        }

        // Get the created audience ID from the response Location header
        const location = response.headers.get('x-restli-id') || response.headers.get('location');
        const audienceId = location || 'unknown';

        // Now upload the entities to the new audience
        if (args.emails || args.companies) {
          const entities = args.emails
            ? args.emails.map(email => ({ userIds: [{ idType: 'SHA256_EMAIL', idValue: email }] }))
            : args.companies!.map(company => ({ organizationName: company }));

          await fetch(`${LINKEDIN_ADS_BASE}/dmpSegments/${audienceId}/users`, {
            method: 'POST',
            headers: getLinkedInHeaders(true),
            body: JSON.stringify({ elements: entities }),
          });
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'created', audience_id: audienceId, audience_name: args.audience_name, entities_added: (args.emails || args.companies)?.length ?? 0 }) }] };
      }
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `LinkedIn sync_audience failed: ${error instanceof Error ? error.message : String(error)}` }) }], isError: true };
    }
  }
);

const linkedinAdsGetCampaigns = tool(
  'linkedin_ads_get_campaigns',
  'List active LinkedIn ad campaigns with performance metrics for the configured ad account.',
  {
    status: z.string().optional().describe('Filter by campaign status: ACTIVE, PAUSED, ARCHIVED, DRAFT. Default: ACTIVE'),
  },
  async (args) => {
    try {
      const adAccountUrn = getAdAccountUrn();
      const status = args.status || 'ACTIVE';

      const params = new URLSearchParams({
        'q': 'search',
        'search.account.values[0]': adAccountUrn,
        'search.status.values[0]': status,
      });

      const response = await fetch(`${LINKEDIN_ADS_BASE}/adCampaigns?${params}`, {
        method: 'GET',
        headers: getLinkedInHeaders(true),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `LinkedIn API error ${response.status}: ${errorText}` }) }], isError: true };
      }

      const data = await response.json();
      const campaigns = (data.elements || []).map((c: any) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        type: c.type,
        cost_type: c.costType,
        daily_budget: c.dailyBudget,
        total_budget: c.totalBudget,
        audience_id: c.targetingCriteria?.audienceMatchingSegments?.[0],
        created_at: c.createdAt,
        last_modified: c.lastModifiedAt,
      }));

      return { content: [{ type: 'text' as const, text: JSON.stringify({ campaign_count: campaigns.length, campaigns }) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `LinkedIn get_campaigns failed: ${error instanceof Error ? error.message : String(error)}` }) }], isError: true };
    }
  }
);

const linkedinAdsUpdateBudget = tool(
  'linkedin_ads_update_budget',
  'Update the daily or total budget for a LinkedIn ad campaign.',
  {
    campaign_id: z.string().describe('LinkedIn campaign ID'),
    daily_budget: z.number().optional().describe('New daily budget in account currency (e.g., 50.00 for $50/day)'),
    total_budget: z.number().optional().describe('New total budget in account currency'),
    status: z.string().optional().describe('Optionally change campaign status: ACTIVE, PAUSED'),
  },
  async (args) => {
    try {
      const patchBody: Record<string, any> = {
        patch: { $set: {} },
      };

      if (args.daily_budget !== undefined) {
        patchBody.patch.$set.dailyBudget = {
          amount: String(Math.round(args.daily_budget * 100)),
          currencyCode: 'USD',
        };
      }
      if (args.total_budget !== undefined) {
        patchBody.patch.$set.totalBudget = {
          amount: String(Math.round(args.total_budget * 100)),
          currencyCode: 'USD',
        };
      }
      if (args.status) {
        patchBody.patch.$set.status = args.status;
      }

      const response = await fetch(`${LINKEDIN_ADS_BASE}/adCampaigns/${args.campaign_id}`, {
        method: 'POST',
        headers: {
          ...getLinkedInHeaders(true),
          'X-Restli-Method': 'PARTIAL_UPDATE',
        },
        body: JSON.stringify(patchBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `LinkedIn API error ${response.status}: ${errorText}` }) }], isError: true };
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'updated', campaign_id: args.campaign_id, changes: patchBody.patch.$set }) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `LinkedIn update_budget failed: ${error instanceof Error ? error.message : String(error)}` }) }], isError: true };
    }
  }
);

const linkedinAdsGetAnalytics = tool(
  'linkedin_ads_get_analytics',
  'Pull campaign analytics (impressions, clicks, conversions, spend) for a date range from LinkedIn Campaign Manager.',
  {
    campaign_ids: z.array(z.string()).optional().describe('Specific campaign IDs to query. Omit for all campaigns.'),
    start_date: z.string().describe('Start date in YYYY-MM-DD format'),
    end_date: z.string().describe('End date in YYYY-MM-DD format'),
  },
  async (args) => {
    try {
      const adAccountUrn = getAdAccountUrn();
      const [startYear, startMonth, startDay] = args.start_date.split('-').map(Number);
      const [endYear, endMonth, endDay] = args.end_date.split('-').map(Number);

      const params = new URLSearchParams({
        'q': 'analytics',
        'pivot': 'CAMPAIGN',
        'dateRange.start.year': String(startYear),
        'dateRange.start.month': String(startMonth),
        'dateRange.start.day': String(startDay),
        'dateRange.end.year': String(endYear),
        'dateRange.end.month': String(endMonth),
        'dateRange.end.day': String(endDay),
        'timeGranularity': 'DAILY',
        'accounts[0]': adAccountUrn,
      });

      if (args.campaign_ids?.length) {
        args.campaign_ids.forEach((id, i) => {
          params.set(`campaigns[${i}]`, `urn:li:sponsoredCampaign:${id}`);
        });
      }

      const response = await fetch(`${LINKEDIN_ADS_BASE}/adAnalytics?${params}`, {
        method: 'GET',
        headers: getLinkedInHeaders(true),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `LinkedIn API error ${response.status}: ${errorText}` }) }], isError: true };
      }

      const data = await response.json();
      const analytics = (data.elements || []).map((row: any) => ({
        campaign: row.pivotValue,
        date: row.dateRange?.start ? `${row.dateRange.start.year}-${String(row.dateRange.start.month).padStart(2, '0')}-${String(row.dateRange.start.day).padStart(2, '0')}` : null,
        impressions: row.impressions ?? 0,
        clicks: row.clicks ?? 0,
        cost_in_usd: row.costInUsd ? parseFloat(row.costInUsd) : 0,
        conversions: row.externalWebsiteConversions ?? 0,
        likes: row.likes ?? 0,
        comments: row.comments ?? 0,
        shares: row.shares ?? 0,
        follows: row.follows ?? 0,
      }));

      // Calculate totals
      const totals = analytics.reduce(
        (acc: any, row: any) => ({
          impressions: acc.impressions + row.impressions,
          clicks: acc.clicks + row.clicks,
          cost_in_usd: acc.cost_in_usd + row.cost_in_usd,
          conversions: acc.conversions + row.conversions,
        }),
        { impressions: 0, clicks: 0, cost_in_usd: 0, conversions: 0 }
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            date_range: { start: args.start_date, end: args.end_date },
            totals,
            ctr: totals.impressions > 0 ? ((totals.clicks / totals.impressions) * 100).toFixed(2) + '%' : '0%',
            cpc: totals.clicks > 0 ? (totals.cost_in_usd / totals.clicks).toFixed(2) : '0',
            daily_breakdown: analytics,
          }),
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `LinkedIn get_analytics failed: ${error instanceof Error ? error.message : String(error)}` }) }], isError: true };
    }
  }
);

export const linkedinAdsServer = createSdkMcpServer({
  name: 'linkedin-ads',
  version: '1.0.0',
  tools: [linkedinAdsSyncAudience, linkedinAdsGetCampaigns, linkedinAdsUpdateBudget, linkedinAdsGetAnalytics],
});
