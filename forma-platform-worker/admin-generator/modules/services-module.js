export function buildServicesEditorModule() {
  return { id: 'services-editor', title: 'Services', editableFields: ['services'], storageTarget: 'site_content.services', enabled: true };
}
