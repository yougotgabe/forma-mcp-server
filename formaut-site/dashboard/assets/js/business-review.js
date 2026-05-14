const demoItems = [
  { bucket: 'confirmed-facts', field: 'business name', value: 'North Ridge Roofing', confidence: 0.94, source: 'crawl_adapter' },
  { bucket: 'confirmed-facts', field: 'phone', value: '(555) 010-0199', confidence: 0.9, source: 'website_footer' },
  { bucket: 'uncertain-facts', field: 'tone', value: 'premium, local, reassuring', confidence: 0.62, source: 'crawl_adapter' },
  { bucket: 'uncertain-facts', field: 'colors', value: 'charcoal, cream, muted gold', confidence: 0.58, source: 'visual_extractor' },
  { bucket: 'contradictions', field: 'business_name', value: 'Existing: North Ridge Roofing · Incoming: NRR Exteriors', confidence: 0.81, source: 'crawl_adapter' }
];

function renderCard(item) {
  const isConflict = item.bucket === 'contradictions';
  return `
    <div class="fact-card">
      <div class="fact-meta"><span>${item.field}</span><span>${Math.round(item.confidence * 100)}%</span></div>
      <div class="fact-value">${item.value}</div>
      <div class="fact-meta"><span>source: ${item.source}</span></div>
      <div class="fact-actions">
        <button class="primary" data-action="approve">Approve</button>
        <button data-action="edit">Edit</button>
        <button class="${isConflict ? 'danger' : ''}" data-action="reject">${isConflict ? 'Resolve' : 'Reject'}</button>
      </div>
    </div>`;
}

function bootBusinessReview() {
  for (const id of ['confirmed-facts', 'uncertain-facts', 'contradictions']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.innerHTML = demoItems.filter(item => item.bucket === id).map(renderCard).join('');
  }
}

bootBusinessReview();
