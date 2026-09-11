/**
 * Step 4 - Routing.
 *
 * Deliberately contains NO LLM call. Routing is a business policy, not a
 * language problem: the same triage output must always produce the same queue,
 * an auditor must be able to read why a ticket went where it went, and an ops
 * lead must be able to change the mapping without re-testing a prompt.
 *
 * The LLM decides WHAT the message is. This table decides WHERE it goes.
 */

export const QUEUES = {
  ENGINEERING: 'Engineering',
  BILLING: 'Billing',
  PRODUCT: 'Product',
  IT_SECURITY: 'IT/Security',
  SUPPORT: 'Support-Tier1',
  ESCALATION: 'Human-Escalation',
};

/** Security-adjacent product areas pull a Technical Question to IT/Security. */
const SECURITY_AREAS = [
  'sso', 'saml', 'okta', 'oauth', 'scim', 'authentication', 'auth',
  'mfa', '2fa', 'security', 'access control', 'permissions', 'encryption',
];

/** First matching rule wins. Each rule carries an id so records are auditable. */
export const ROUTING_TABLE = [
  {
    id: 'R1-incident-to-engineering',
    when: (t) => t.category === 'Incident/Outage',
    queue: QUEUES.ENGINEERING,
    why: 'Service degradation is owned by the on-call engineering rotation.',
  },
  {
    id: 'R2-bug-to-engineering',
    when: (t) => t.category === 'Bug Report',
    queue: QUEUES.ENGINEERING,
    why: 'Defects are triaged by engineering regardless of severity.',
  },
  {
    id: 'R3-billing-to-billing',
    when: (t) => t.category === 'Billing Issue',
    queue: QUEUES.BILLING,
    why: 'Only Billing can inspect contract rates and issue credits.',
  },
  {
    id: 'R4-feature-to-product',
    when: (t) => t.category === 'Feature Request',
    queue: QUEUES.PRODUCT,
    why: 'Product owns the roadmap intake and the customer response.',
  },
  {
    id: 'R5-security-question-to-it-security',
    when: (t) =>
      t.category === 'Technical Question' &&
      [...(t.entities?.product_areas ?? []), t.core_issue ?? '']
        .join(' ')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .join(' ')
        .match(new RegExp(`\\b(${SECURITY_AREAS.join('|')})\\b`)),
    queue: QUEUES.IT_SECURITY,
    why: 'Identity and access questions require a security-reviewed answer.',
  },
  {
    id: 'R6-technical-question-to-support',
    when: (t) => t.category === 'Technical Question',
    queue: QUEUES.SUPPORT,
    why: 'General how-to questions are answered by Tier 1 from the knowledge base.',
  },
];

/** SLA is a function of priority and queue, published with the record so the
 *  receiving team does not have to look it up. */
export function slaTargetHours(priority, queue) {
  if (queue === QUEUES.ESCALATION) return 1;
  return { High: 4, Medium: 24, Low: 72 }[priority] ?? 24;
}

/**
 * @returns {{destination_queue: string, routing_rule: string, routing_rationale: string}}
 */
export function routeByClassification(triage) {
  const rule = ROUTING_TABLE.find((r) => r.when(triage));
  if (!rule) {
    return {
      destination_queue: QUEUES.SUPPORT,
      routing_rule: 'R0-default-fallback',
      routing_rationale:
        'No routing rule matched; defaulted to Tier 1 so the request is never dropped.',
    };
  }
  return {
    destination_queue: rule.queue,
    routing_rule: rule.id,
    routing_rationale: rule.why,
  };
}
