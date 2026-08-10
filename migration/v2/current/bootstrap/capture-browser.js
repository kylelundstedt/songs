/* Evaluate on the current bootstrap harness after applying the matching viewport. */
async function captureCurrentBootstrap(profileName) {
  const profiles = {
    'ipad-portrait': {width:1024,height:1366,device_scale_factor:1,mobile:false,touch:true,form_factor:'tablet'},
    'ipad-landscape': {width:1366,height:1024,device_scale_factor:1,mobile:false,touch:true,form_factor:'tablet'},
    phone: {width:390,height:844,device_scale_factor:1,mobile:true,touch:true,form_factor:'phone'},
  };
  const requestedProfile = profiles[profileName];
  if (!requestedProfile) throw new Error(`unknown profile ${profileName}`);
  const {form_factor, ...requested} = requestedProfile;
  const baseline = await fetch('/bootstrap-baseline.json', {cache:'no-store'}).then(response => response.json());
  const result = await BootstrapSpike.fullScenario();
  const capture = {
    schema_version:'1',...result,
    evidence_binding:{
      bootstrap_baseline_output_sha256:baseline.verification.output_sha256,
      payload_manifest_sha256:baseline.payload.manifest_sha256,
      harness_assets:baseline.assets,
      harness_source_commit:baseline.harness_source.commit,
    },
    profile:{name:profileName,requested,observed:{inner_width:innerWidth,inner_height:innerHeight,device_pixel_ratio:devicePixelRatio,form_factor,max_touch_points:navigator.maxTouchPoints}},
    browser_engine:{name:'Chromium',user_agent:navigator.userAgent,platform:navigator.platform},
  };
  const response = await fetch(`/__observations/${profileName}.json`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(capture)});
  if (!response.ok) throw new Error(`store capture: ${response.status}`);
  return {documents:capture.documents,durations_ms:capture.durations_ms,proof:capture.scenario_proof};
}
