/**
 * GoExtrovert MCP Server — Custom in-process MCP server for GoExtrovert API
 *
 * GoExtrovert is a LinkedIn engagement tool. Campaigns are configured in the
 * GoExtrovert UI; the agent system pushes prospects to campaigns via API and
 * pulls engagement stats back.
 *
 * API Docs: https://api-docs.goextrovert.com/
 * Base URL: https://api.goextrovert.com/client/v1
 * Auth: x-api-key header
 * Rate limit: 10 requests/second
 *
 * Tools:
 * - goextrovert_add_prospect: Add a prospect to a campaign
 * - goextrovert_get_prospects: Get prospects with engagement stats
 * - goextrovert_remove_prospect: Remove a prospect from a campaign
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const GOEXTROVERT_API_BASE = 'https://api.goextrovert.com/client/v1';

function getGoExtrovertHeaders(): HeadersInit {
  return {
    'x-api-key': process.env.GOEXTROVERT_API_KEY || '',
    'Content-Type': 'application/json',
  };
}

const goextrovertAddProspect = tool(
  'goextrovert_add_prospect',
  'Add a prospect to a GoExtrovert campaign by LinkedIn URL. The campaign (pre-configured in GoExtrovert UI) handles all engagement and outreach automatically. Returns success or error.',
  {
    prospect_profile_url: z.string().describe('LinkedIn profile URL of the prospect'),
    campaign_id: z.string().describe('GoExtrovert campaign UUID'),
    prospect_list_id: z.string().describe('GoExtrovert prospect list UUID within the campaign'),
    move_duplicated_prospect: z.boolean().optional().describe('If true, move existing duplicates instead of rejecting. Default false.'),
  },
  async (args) => {
    try {
      const response = await fetch(`${GOEXTROVERT_API_BASE}/prospects`, {
        method: 'POST',
        headers: getGoExtrovertHeaders(),
        body: JSON.stringify({
          prospectProfileUrl: args.prospect_profile_url,
          campaignId: args.campaign_id,
          prospectListId: args.prospect_list_id,
          moveDuplicatedProspect: args.move_duplicated_prospect ?? false,
        }),
      });

      if (response.status === 429) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'GoExtrovert rate limit hit (10 req/sec). Stop pushing and retry on next cron.' }) }],
          isError: true,
        };
      }

      if (response.status === 400) {
        const errorBody = await response.json().catch(() => ({}));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `GoExtrovert rejected prospect: ${JSON.stringify(errorBody)}` }) }],
          isError: true,
        };
      }

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `GoExtrovert API error ${response.status}: ${errorText}` }) }],
          isError: true,
        };
      }

      const result = await response.json();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ status: 'success', message: result.message || 'Prospect added', data: result.data }) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `GoExtrovert add_prospect failed: ${error instanceof Error ? error.message : String(error)}` }) }],
        isError: true,
      };
    }
  }
);

const goextrovertGetProspects = tool(
  'goextrovert_get_prospects',
  'Get prospects with detailed engagement statistics for a GoExtrovert campaign. Returns posts fetched, direct comments, indirect comments, likes, and date ranges for each prospect.',
  {
    campaign_id: z.string().describe('GoExtrovert campaign UUID'),
    list_id: z.string().optional().describe('Optional: filter by specific prospect list UUID'),
  },
  async (args) => {
    try {
      const params = new URLSearchParams({ campaignId: args.campaign_id });
      if (args.list_id) {
        params.set('listId', args.list_id);
      }

      const response = await fetch(`${GOEXTROVERT_API_BASE}/prospects?${params}`, {
        method: 'GET',
        headers: getGoExtrovertHeaders(),
      });

      if (response.status === 429) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'GoExtrovert rate limit hit.' }) }],
          isError: true,
        };
      }

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `GoExtrovert API error ${response.status}: ${errorText}` }) }],
          isError: true,
        };
      }

      const prospects = await response.json();

      // Map to a cleaner format for the agent
      const mapped = Array.isArray(prospects)
        ? prospects.map((p: any) => ({
            id: p.id,
            full_name: p.fullName,
            linkedin_url: p.prospectProfileUrl,
            campaign_id: p.campaignId,
            campaign_name: p.campaignName,
            list_id: p.listId,
            list_name: p.listName,
            added_at: p.createdAt,
            // Engagement stats
            posts_fetched: p.postsFetched ?? 0,
            direct_comments: p.directComments ?? 0,
            indirect_comments: p.indirectComments ?? 0,
            likes: p.likes ?? 0,
            oldest_fetched_post: p.oldestFetchedPost,
            newest_fetched_post: p.newestFetchedPost,
            recent_direct_comment_date: p.recentDirectCommentDate,
            recent_indirect_comment_date: p.recentIndirectCommentDate,
            // Connection tracking
            was_connection_request_sent: p.wasConnectionRequestSentViaExtrovert,
            connection_request_sent_date: p.connectionRequestSentDate,
            connection_status: p.connectionStatus,
            connected_date: p.connectedDate,
          }))
        : [];

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ prospect_count: mapped.length, prospects: mapped }) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `GoExtrovert get_prospects failed: ${error instanceof Error ? error.message : String(error)}` }) }],
        isError: true,
      };
    }
  }
);

const goextrovertRemoveProspect = tool(
  'goextrovert_remove_prospect',
  'Remove a prospect from a GoExtrovert campaign. Use when a lead should no longer receive engagement (e.g., manual override, disqualified).',
  {
    campaign_id: z.string().describe('GoExtrovert campaign UUID'),
    prospect_profile_url: z.string().describe('LinkedIn profile URL of the prospect to remove'),
    reject_posts: z.boolean().optional().describe('If true, reject pending posts for this prospect. Default true.'),
  },
  async (args) => {
    try {
      const response = await fetch(`${GOEXTROVERT_API_BASE}/prospects`, {
        method: 'DELETE',
        headers: getGoExtrovertHeaders(),
        body: JSON.stringify({
          campaignId: args.campaign_id,
          prospectProfileUrl: args.prospect_profile_url,
          rejectPosts: args.reject_posts ?? true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `GoExtrovert API error ${response.status}: ${errorText}` }) }],
          isError: true,
        };
      }

      const result = await response.json();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ status: 'success', message: result.message || 'Prospect removed' }) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `GoExtrovert remove_prospect failed: ${error instanceof Error ? error.message : String(error)}` }) }],
        isError: true,
      };
    }
  }
);

export const goextrovertServer = createSdkMcpServer({
  name: 'goextrovert',
  version: '1.0.0',
  tools: [goextrovertAddProspect, goextrovertGetProspects, goextrovertRemoveProspect],
});
