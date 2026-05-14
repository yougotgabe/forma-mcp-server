export function generateEmailArtifact({ rule, event, template }) {
  return { type: 'email_html', rule_id: rule.id, subject: rule.subject || template.subject, html: template.html, data: event.data || {}, review_status: rule.requires_review ? 'draft' : 'approved' };
}
