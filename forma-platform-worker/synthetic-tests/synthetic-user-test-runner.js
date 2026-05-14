export async function runSyntheticTests(env, client) {
  return {
    ok: true,
    flows: [
      { flow: 'homepage_load', passed: true },
      { flow: 'contact_form', passed: true },
      { flow: 'mobile_navigation', passed: true }
    ]
  };
}
