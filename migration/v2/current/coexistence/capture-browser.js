/* Evaluate on each origin served by serve_v2_current_coexistence_harness.py. */
async function captureCurrentCoexistence(role) {
  let result;
  if (role === 'v2') {
    result = await OriginProbe.run();
  } else if (role === 'v1') {
    const registration = await navigator.serviceWorker.ready;
    await new Promise(resolve => {
      if (navigator.serviceWorker.controller) return resolve();
      const timer = setTimeout(resolve, 2000);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, {once:true});
    });
    const databases = indexedDB.databases ? await indexedDB.databases() : [];
    result = {
      role:'v1',origin:location.origin,implementation:'actual-frozen-v1',
      service_worker:{scope:registration.scope,script_url:registration.active?.scriptURL||null,controlled:Boolean(navigator.serviceWorker.controller)},
      cache_names:(await caches.keys()).sort(),database_names:databases.map(item => item.name).filter(Boolean).sort(),
      expected:{cache:'songs-shell-v28',database:null},
    };
  } else {
    throw new Error(`unknown role ${role}`);
  }
  const capture = {
    schema_version:'1',baseline:{ref:'v2-phase1-content-2026-08-10',commit:'17c326c8957ac2fbe623b2de0fe91a4eb0a1b4c5'},
    ...result,browser_engine:{name:'Chromium',user_agent:navigator.userAgent,platform:navigator.platform},
  };
  const response = await fetch('/__observation.json', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(capture)});
  if (!response.ok) throw new Error(`store capture: ${response.status}`);
  return capture;
}
