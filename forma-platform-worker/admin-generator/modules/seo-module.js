export function buildSeoEditorModule({ seo_enabled = true } = {}) {
  return { id: 'seo-editor', title: 'SEO', editableFields: ['title','description','og_image','local_keywords'], storageTarget: 'site_content.seo', enabled: Boolean(seo_enabled) };
}
