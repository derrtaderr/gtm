/**
 * GoExtrovert Sync Helpers
 *
 * Maps GoExtrovert API responses to internal database fields.
 * Used by the orchestrator when processing daily cron pull results.
 */

/**
 * GoExtrovert prospect engagement stats from GET /prospects
 */
export interface GoExtrovertProspectStats {
  id: string;
  full_name: string;
  linkedin_url: string;
  campaign_id: string;
  campaign_name: string;
  list_id: string;
  list_name: string;
  added_at: string;
  // Engagement stats
  posts_fetched: number;
  direct_comments: number;
  indirect_comments: number;
  likes: number;
  oldest_fetched_post: string | null;
  newest_fetched_post: string | null;
  recent_direct_comment_date: string | null;
  recent_indirect_comment_date: string | null;
  // Connection tracking (GoExtrovert also handles connection requests)
  was_connection_request_sent: boolean | null;
  connection_request_sent_date: string | null;
  connection_status: string | null;
  connected_date: string | null;
}

/**
 * Derive an outreach_status string from GoExtrovert engagement stats.
 *
 * GoExtrovert tracks both engagement AND connection requests. Map to:
 *
 * - 'queued': Added but no activity yet
 * - 'engaging': Posts found, engagement started (posts_fetched > 0)
 * - 'active': Comments being made (direct_comments > 0)
 * - 'sent': Connection request sent via GoExtrovert
 * - 'connected': Connection accepted
 * - 'warmed': Significant engagement (direct_comments >= 3 OR total >= 10)
 */
export function deriveOutreachStatus(stats: GoExtrovertProspectStats): string {
  // Connection status takes priority when available
  if (stats.connection_status === 'connected' || stats.connected_date) {
    return 'connected';
  }
  if (stats.was_connection_request_sent || stats.connection_request_sent_date) {
    return 'sent';
  }

  // Fall back to engagement depth
  const totalEngagement = stats.direct_comments + stats.indirect_comments + stats.likes;

  if (stats.direct_comments >= 3 || totalEngagement >= 10) {
    return 'warmed';
  }
  if (stats.direct_comments > 0 || stats.indirect_comments > 0) {
    return 'active';
  }
  if (stats.posts_fetched > 0) {
    return 'engaging';
  }
  return 'queued';
}

/**
 * Build the SQL values for updating the goextrovert_sync table
 * from GoExtrovert prospect stats.
 */
export function buildSyncUpdateFields(stats: GoExtrovertProspectStats): {
  outreach_status: string;
  posts_fetched: number;
  direct_comments: number;
  indirect_comments: number;
  likes: number;
  last_status_check: string;
} {
  return {
    outreach_status: deriveOutreachStatus(stats),
    posts_fetched: stats.posts_fetched,
    direct_comments: stats.direct_comments,
    indirect_comments: stats.indirect_comments,
    likes: stats.likes,
    last_status_check: new Date().toISOString(),
  };
}

/**
 * Determine if a lead's status should be updated on the leads table
 * based on GoExtrovert engagement progression.
 *
 * Returns the new leads.status value if it should change, or null if no change.
 */
export function shouldUpdateLeadStatus(
  currentLeadStatus: string,
  newOutreachStatus: string
): string | null {
  // Only update from 'in_outreach' — don't downgrade from 'connected' or 'replied'
  if (currentLeadStatus !== 'in_outreach' && currentLeadStatus !== 'scored') {
    return null;
  }

  // When prospect is "warmed" by GoExtrovert, mark as connected
  // (they've had meaningful content engagement)
  if (newOutreachStatus === 'warmed') {
    return 'connected';
  }

  return null;
}
