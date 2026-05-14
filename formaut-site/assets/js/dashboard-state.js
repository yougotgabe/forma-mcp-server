/* Extracted from dashboard.html. Loaded as an ordered classic script. */
// ── State ─────────────────────────────────────────────────────────────────
    let conversationHistory = [];
    let isWaiting = false;
    let sessionId = null;
    let sessionContext = null; // cached after first turn — avoids repeat Supabase fetches


    const CONNECTION_PROVIDERS = [
      {
        id: 'printify',
        title: 'Printify',
        category: 'Commerce',
        auth_type: 'api_key',
        status: 'disconnected',
        description: 'Sync products and fulfillment for print-on-demand stores.',
        secret_label: 'Printify access token',
        help_text: 'Create a personal access token in Printify, then paste it here.',
        actions: ['connect', 'sync_products']
      },
      {
        id: 'stripe',
        title: 'Stripe',
        category: 'Payments',
        auth_type: 'oauth_redirect',
        status: 'soon',
        description: 'Accept payments, create checkout sessions, subscriptions, and invoices.',
        actions: ['connect']
      },
      {
        id: 'mailchimp',
        title: 'Mailchimp',
        category: 'Marketing',
        auth_type: 'oauth_redirect',
        status: 'soon',
        description: 'Sync email audiences and send campaigns from business memory.',
        actions: ['connect']
      },
      {
        id: 'google',
        title: 'Google Workspace',
        category: 'Workspace',
        auth_type: 'oauth_redirect',
        status: 'soon',
        description: 'Connect Gmail, Calendar, Drive, Docs, Sheets, and Contacts.',
        actions: ['connect']
      },
      {
        id: 'square',
        title: 'Square',
        category: 'Payments / POS',
        auth_type: 'oauth_redirect',
        status: 'soon',
        description: 'Sync POS data, customers, catalog items, and appointments.',
        actions: ['connect']
      },
      {
        id: 'quickbooks',
        title: 'QuickBooks',
        category: 'Accounting',
        auth_type: 'oauth_redirect',
        status: 'soon',
        description: 'Read invoices, customers, and accounting context without replacing the ledger.',
        actions: ['connect']
      }
    ];

    let connectionState = {};
    let currentSecretProvider = null;
    let jobsPollTimer = null;

    function providerById(id) {
      return CONNECTION_PROVIDERS.find(p => p.id === id);
    }

    function getConnectionSuccessMessage(providerId) {
      if (providerId === 'printify') {
        return [
          'Printify is connected.',
          '',
          'Formaut can now read your Printify shops, products, variants, product images, and fulfillment information so product-related website work can be based on your real catalog instead of manual descriptions.',
          '',
          'Printify handles the product and fulfillment side of commerce, but payment processing still requires a payment provider connection. Stripe will also need to be connected before Formaut can fully set up checkout flows, payment collection, subscriptions, invoices, or live storefront purchasing.',
          '',
          'Recommended next step: sync your Printify products, then connect Stripe when you are ready to enable payments.'
        ].join('\n');
      }

      if (providerId === 'stripe') {
        return [
          'Stripe is connected.',
          '',
          'Formaut can now use Stripe for payment-related infrastructure including checkout sessions, invoices, subscriptions, customer payment flows, and transactional payment logic.',
          '',
          'If you are selling physical or print-on-demand products, a commerce or fulfillment integration such as Printify is also required so Formaut knows what products exist and how fulfillment should work.'
        ].join('\n');
      }

      if (providerId === 'mailchimp') {
        return [
          'Mailchimp is connected.',
          '',
          'Formaut can now sync audiences, contacts, and campaigns so website forms, newsletter flows, and marketing automations can connect directly into your marketing system.',
          '',
          'For advanced customer segmentation and purchase-driven automations, commerce and payment integrations such as Printify and Stripe are also recommended.'
        ].join('\n');
      }

      if (providerId === 'google') {
        return [
          'Google Workspace is connected.',
          '',
          'Formaut can now use Gmail, Calendar, Drive, Docs, Sheets, and Contacts context to support scheduling, communication workflows, document generation, and business operations.',
          '',
          'Additional integrations may still be required depending on your business workflows, such as Stripe for payments or Printify for commerce fulfillment.'
        ].join('\n');
      }

      if (providerId === 'quickbooks') {
        return [
          'QuickBooks is connected.',
          '',
          'Formaut can now read accounting-related business context such as invoices, customers, and financial records without replacing your accounting platform.',
          '',
          'For complete operational workflows, additional integrations such as Stripe for payment collection may also be required.'
        ].join('\n');
      }

      return `${providerById(providerId)?.title || 'This service'} is connected. Formaut can now use it when tasks depend on that business system.`;
    }
