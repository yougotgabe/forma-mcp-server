export const WORKSPACE_MANIFESTS = Object.freeze({
  core: ['get_client', 'update_client', 'get_session_history', 'write_session_summary', 'platform_query', 'platform_write'],
  site: ['list_files', 'read_file', 'bulk_file_read', 'edit_file', 'delete_file', 'trigger_deploy', 'check_deploy_status', 'list_deployments', 'deploy_change', 'get_site_health', 'stage_content_change', 'preview_staged_change', 'commit_staged_change', 'get_pending_reviews'],
  memory: ['get_client_context', 'get_business_profile', 'get_session_history', 'write_session_summary', 'platform_query', 'platform_write', 'export_agent_package'],
  email: ['get_email_workspace', 'register_email_artifact', 'preview_email_artifact', 'register_email_rule', 'activate_email_rule', 'pause_email_rule'],
  infrastructure: ['get_supabase_capacity_status', 'get_client_infrastructure', 'provision_client_infrastructure', 'get_client_infrastructure_health', 'repair_client_infrastructure'],
  operations: ['platform_health', 'get_site_health', 'get_pending_reviews', 'stage_content_change', 'preview_staged_change', 'commit_staged_change', 'rollback_deployment', 'get_operational_lineage', 'generate_remediation_plan', 'get_service_requests', 'update_service_request'],
  deployment: ['deploy_change', 'trigger_deploy', 'check_deploy_status', 'list_deployments', 'stage_content_change', 'preview_staged_change', 'commit_staged_change', 'rollback_deployment'],
  full: ['*']
});
