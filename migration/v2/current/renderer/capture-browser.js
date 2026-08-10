/* Evaluate on the recorder/proxy origin served by serve_v2_current_fit_harness.py. */
async function captureCurrentFit(profileName) {
  const profiles = {
    'ipad-portrait': {width:1024,height:1366,device_scale_factor:1,mobile:false,touch:true},
    'ipad-landscape': {width:1366,height:1024,device_scale_factor:1,mobile:false,touch:true},
    phone: {width:390,height:844,device_scale_factor:1,mobile:true,touch:true},
  };
  const requested = profiles[profileName];
  if (!requested) throw new Error(`unknown profile ${profileName}`);
  const data = await fetch('/data.json', {cache:'no-store'}).then(response => response.json());
  const results = [];
  for (const song of data.songs) {
    const response = await fetch('/song/' + encodeURIComponent(song.id));
    if (!response.ok) throw new Error(`route ${song.id}: ${response.status}`);
    const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
    const panel = parsed.querySelector('[data-lead-sheet]');
    if (!panel) throw new Error(`missing panel ${song.id}`);
    document.querySelector('[data-lead-sheet]').replaceWith(panel);
    await SongsApp.fitSheet(panel);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const viewport = panel.querySelector('[data-sheet-viewport]');
    const columns = [...panel.querySelectorAll('[data-live-columns] > .live-column')];
    results.push({
      id:song.id,title:song.title,path:song.path,source_hash:song.source_hash,
      status:panel.dataset.fitStatus,body_px:Number(panel.dataset.bodyPx),
      auto_body_px:Number(panel.dataset.autoBodyPx),line_height:Number(panel.dataset.lineHeight),
      column_count:Number(panel.dataset.columnCount),
      viewport:{client_width:viewport.clientWidth,client_height:viewport.clientHeight,scroll_width:viewport.scrollWidth,scroll_height:viewport.scrollHeight},
      columns:columns.map(column => ({client_width:column.clientWidth,scroll_width:column.scrollWidth,client_height:column.clientHeight,scroll_height:column.scrollHeight})),
    });
  }
  const capture = {
    schema_version:'1',baseline:data.baseline,
    measurement_surface:'frozen current /song/{id} lead-sheet panel after SongsApp.fitSheet',
    profile:{name:profileName,requested,observed:{inner_width:innerWidth,inner_height:innerHeight,device_pixel_ratio:devicePixelRatio,form_factor:SongsApp.detectFormFactor(),user_agent:navigator.userAgent,platform:navigator.platform,max_touch_points:navigator.maxTouchPoints}},
    results,
  };
  const response = await fetch(`/__observations/${profileName}.json`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(capture)});
  if (!response.ok) throw new Error(`store capture: ${response.status}`);
  return {count:results.length,failures:results.filter(result => result.status === 'needs-editing').map(result => result.id)};
}
