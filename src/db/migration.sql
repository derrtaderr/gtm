-- Magnetiz GTM Agent System V2 — Database Schema
-- All 8 tables already exist in Supabase (from Command Center build).
-- This file serves as reference and safety net (CREATE IF NOT EXISTS).
-- Run only if tables are missing or to add missing indexes.

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  linkedin_url TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  title TEXT,
  company_name TEXT,
  industry TEXT,
  employee_count TEXT,
  revenue_range TEXT,
  city TEXT,
  state TEXT,
  website TEXT,
  work_email TEXT,
  coverage_score FLOAT DEFAULT 0,
  enrichment_source TEXT,
  status TEXT DEFAULT 'new',
  goextrovert_id TEXT,
  goextrovert_synced BOOLEAN DEFAULT false,
  goextrovert_synced_at TIMESTAMPTZ,
  previous_score INT,
  manual_override BOOLEAN DEFAULT false,
  override_reason TEXT,
  notes TEXT,
  paused BOOLEAN DEFAULT false,
  paused_at TIMESTAMPTZ,
  paused_by TEXT,
  last_agent_action TEXT,
  last_agent_action_at TIMESTAMPTZ,
  visit_count INT DEFAULT 1,
  last_seen TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id),
  signal_type TEXT NOT NULL,
  signal_data JSONB,
  strength INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS icp_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) UNIQUE,
  total_score INT NOT NULL,
  title_match INT,
  company_fit INT,
  signal_strength INT,
  engagement INT,
  routing TEXT NOT NULL,
  scored_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS goextrovert_sync (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) UNIQUE,
  goextrovert_campaign_id TEXT,
  push_status TEXT DEFAULT 'pending',
  outreach_status TEXT,
  connection_sent_at TIMESTAMPTZ,
  connection_accepted_at TIMESTAMPTZ,
  reply_received_at TIMESTAMPTZ,
  follow_up_count INT DEFAULT 0,
  last_status_check TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retarget_audience (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id),
  funnel_layer TEXT NOT NULL,
  synced_to_linkedin BOOLEAN DEFAULT false,
  last_synced TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outreach_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id),
  action_type TEXT NOT NULL,
  message TEXT,
  status TEXT,
  source TEXT DEFAULT 'goextrovert',
  executed_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id),
  agent_name TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_detail JSONB,
  status TEXT DEFAULT 'success',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE UNIQUE NOT NULL,
  signals_received INT DEFAULT 0,
  leads_created INT DEFAULT 0,
  leads_enriched INT DEFAULT 0,
  leads_scored INT DEFAULT 0,
  routed_outreach INT DEFAULT 0,
  routed_retarget INT DEFAULT 0,
  routed_monitoring INT DEFAULT 0,
  outreach_pushed INT DEFAULT 0,
  connections_accepted INT DEFAULT 0,
  replies_received INT DEFAULT 0,
  avg_icp_score FLOAT,
  avg_coverage_score FLOAT,
  monitoring_pool_size INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_leads_linkedin_url ON leads(linkedin_url);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_goextrovert_sync ON leads(goextrovert_synced) WHERE goextrovert_synced = false;
CREATE INDEX IF NOT EXISTS idx_signals_lead_id ON signals(lead_id);
CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at);
CREATE INDEX IF NOT EXISTS idx_icp_scores_lead_id ON icp_scores(lead_id);
CREATE INDEX IF NOT EXISTS idx_icp_scores_routing ON icp_scores(routing);
CREATE INDEX IF NOT EXISTS idx_goextrovert_sync_lead_id ON goextrovert_sync(lead_id);
CREATE INDEX IF NOT EXISTS idx_goextrovert_sync_status ON goextrovert_sync(push_status, outreach_status);
CREATE INDEX IF NOT EXISTS idx_agent_activity_log_lead_id ON agent_activity_log(lead_id);
CREATE INDEX IF NOT EXISTS idx_agent_activity_log_created_at ON agent_activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date);

-- ============================================================
-- FUNCTIONS
-- ============================================================

CREATE OR REPLACE FUNCTION fn_populate_daily_metrics(target_date DATE DEFAULT CURRENT_DATE)
RETURNS void AS $$
BEGIN
  INSERT INTO daily_metrics (
    date, signals_received, leads_created, leads_enriched, leads_scored,
    routed_outreach, routed_retarget, routed_monitoring, outreach_pushed,
    connections_accepted, replies_received, avg_icp_score, avg_coverage_score,
    monitoring_pool_size
  )
  VALUES (
    target_date,
    (SELECT COUNT(*) FROM signals WHERE created_at::date = target_date),
    (SELECT COUNT(*) FROM leads WHERE created_at::date = target_date),
    (SELECT COUNT(*) FROM agent_activity_log WHERE action_type = 'enrichment_completed' AND created_at::date = target_date),
    (SELECT COUNT(*) FROM agent_activity_log WHERE action_type = 'icp_scored' AND created_at::date = target_date),
    (SELECT COUNT(*) FROM icp_scores WHERE routing = 'outreach' AND scored_at::date = target_date),
    (SELECT COUNT(*) FROM icp_scores WHERE routing = 'retarget' AND scored_at::date = target_date),
    (SELECT COUNT(*) FROM icp_scores WHERE routing = 'monitoring' AND scored_at::date = target_date),
    (SELECT COUNT(*) FROM agent_activity_log WHERE action_type = 'pushed_to_goextrovert' AND created_at::date = target_date),
    (SELECT COUNT(*) FROM agent_activity_log WHERE action_type = 'goextrovert_connected' AND created_at::date = target_date),
    (SELECT COUNT(*) FROM agent_activity_log WHERE action_type = 'goextrovert_replied' AND created_at::date = target_date),
    (SELECT AVG(total_score) FROM icp_scores WHERE scored_at::date = target_date),
    (SELECT AVG(coverage_score) FROM leads WHERE created_at::date = target_date AND coverage_score > 0),
    (SELECT COUNT(*) FROM leads WHERE status = 'monitoring')
  )
  ON CONFLICT (date) DO UPDATE SET
    signals_received = EXCLUDED.signals_received,
    leads_created = EXCLUDED.leads_created,
    leads_enriched = EXCLUDED.leads_enriched,
    leads_scored = EXCLUDED.leads_scored,
    routed_outreach = EXCLUDED.routed_outreach,
    routed_retarget = EXCLUDED.routed_retarget,
    routed_monitoring = EXCLUDED.routed_monitoring,
    outreach_pushed = EXCLUDED.outreach_pushed,
    connections_accepted = EXCLUDED.connections_accepted,
    replies_received = EXCLUDED.replies_received,
    avg_icp_score = EXCLUDED.avg_icp_score,
    avg_coverage_score = EXCLUDED.avg_coverage_score,
    monitoring_pool_size = EXCLUDED.monitoring_pool_size;
END;
$$ LANGUAGE plpgsql;
