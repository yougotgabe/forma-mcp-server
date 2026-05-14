export function buildHeroEditorModule({ config = {} } = {}) {
  return { id: 'hero-editor', title: 'Hero Section', editableFields: ['headline','subheadline','cta_text','background_image'], storageTarget: 'site_content.hero', enabled: true, config };
}
